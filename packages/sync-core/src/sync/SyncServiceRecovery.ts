/**
 * SyncService recovery operations.
 *
 * - `hardResync`: wipe local sync tables + apply a fresh server snapshot.
 * - `rebase`: snapshot-reset while preserving pending local (unsynced) actions by replaying them on top.
 *
 * This file is intentionally an orchestrator; large blocks are split into helpers:
 * - `SyncServiceRecoverySnapshot` (fetch snapshot + normalize errors)
 * - `SyncServiceRecoveryClearSyncTables` (wipe sync tables with patch tracking disabled)
 * - `SyncServiceRecoveryRebasePending` (load pending actions + bucket CORRECTION AMRs)
 * - `SyncServiceRecoveryRebaseReplay` (reinsert + replay pending actions deterministically)
 */
import type { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { ActionModifiedRowRepo } from "../ActionModifiedRowRepo"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ActionRegistry } from "../ActionRegistry"
import type { ClientClockState } from "../ClientClockState"
import type { ClientDbAdapterService } from "../ClientDbAdapter"
import type { DeterministicId } from "../DeterministicId"
import type { SyncNetworkService } from "../SyncNetworkService"
import type { BootstrapSnapshot } from "./SyncServiceBootstrap"
import { clearSyncTablesInTx } from "./SyncServiceRecoveryClearSyncTables"
import { loadRebasePendingActions } from "./SyncServiceRecoveryRebasePending"
import { makeRebaseReplayer } from "./SyncServiceRecoveryRebaseReplay"
import { fetchBootstrapSnapshotOrFail } from "./SyncServiceRecoverySnapshot"

export const makeRecovery = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly clientDbAdapter: ClientDbAdapterService
	readonly clockState: ClientClockState
	readonly actionRecordRepo: ActionRecordRepo
	readonly actionModifiedRowRepo: ActionModifiedRowRepo
	readonly syncNetworkService: SyncNetworkService
	readonly clientId: string
	readonly actionRegistry: ActionRegistry
	readonly deterministicId: DeterministicId
	readonly newTraceId: Effect.Effect<string>
	readonly applyBootstrapSnapshot: (
		snapshot: BootstrapSnapshot
	) => Effect.Effect<void, unknown, never>
	readonly applyBootstrapSnapshotInTx: (
		snapshot: BootstrapSnapshot
	) => Effect.Effect<void, unknown, never>
}) => {
	const {
		sqlClient,
		clientDbAdapter,
		clockState,
		actionRecordRepo,
		actionModifiedRowRepo,
		syncNetworkService,
		clientId,
		actionRegistry,
		deterministicId,
		newTraceId,
		applyBootstrapSnapshot,
		applyBootstrapSnapshotInTx
	} = deps

	const rebaseReplayer = makeRebaseReplayer({
		sqlClient,
		clientDbAdapter,
		clockState,
		actionRecordRepo,
		actionRegistry,
		deterministicId,
		clientId
	})

	const hardResync = () =>
		newTraceId.pipe(
			Effect.flatMap((resyncId) =>
				Effect.gen(function* () {
					yield* Effect.logInfo("hardResync.start", { resyncId, clientId })

					const snapshot = yield* fetchBootstrapSnapshotOrFail(syncNetworkService)

					yield* Effect.logInfo("hardResync.clearSyncTables", { resyncId, clientId })
					yield* clearSyncTablesInTx({ sqlClient, clientDbAdapter }).pipe(sqlClient.withTransaction)

					yield* Effect.logInfo("hardResync.applySnapshot", {
						resyncId,
						clientId,
						serverIngestId: snapshot.serverIngestId,
						tableCount: snapshot.tables.length
					})
					yield* applyBootstrapSnapshot(snapshot)

					yield* Effect.logInfo("hardResync.done", {
						resyncId,
						clientId,
						serverIngestId: snapshot.serverIngestId
					})
				}).pipe(
					Effect.annotateLogs({ clientId, resyncId, operation: "hardResync" }),
					Effect.withSpan("SyncService.hardResync", { attributes: { clientId, resyncId } })
				)
			)
		)

	const rebase = () =>
		newTraceId.pipe(
			Effect.flatMap((rebaseId) =>
				Effect.gen(function* () {
					yield* Effect.logInfo("rebase.start", { rebaseId, clientId })

					const snapshot = yield* fetchBootstrapSnapshotOrFail(syncNetworkService)

					yield* Effect.logInfo("rebase.snapshot.received", {
						rebaseId,
						clientId,
						serverIngestId: snapshot.serverIngestId,
						tableCount: snapshot.tables.length
					})

					yield* Effect.gen(function* () {
						const {
							pendingActions,
							pendingCorrectionActionIds,
							pendingCorrectionAmrs,
							pendingCorrectionAmrsByActionId
						} = yield* loadRebasePendingActions({ actionRecordRepo, actionModifiedRowRepo })

						yield* Effect.logInfo("rebase.pending", {
							rebaseId,
							clientId,
							pendingActionCount: pendingActions.length,
							pendingCorrectionActionCount: pendingCorrectionActionIds.length,
							pendingCorrectionAmrCount: pendingCorrectionAmrs.length
						})

						yield* clearSyncTablesInTx({ sqlClient, clientDbAdapter })

						yield* applyBootstrapSnapshotInTx(snapshot)

						yield* rebaseReplayer.replayPendingActions(
							pendingActions,
							pendingCorrectionAmrsByActionId
						)
					}).pipe(sqlClient.withTransaction)

					yield* Effect.logInfo("rebase.done", {
						rebaseId,
						clientId,
						serverIngestId: snapshot.serverIngestId
					})
				}).pipe(
					Effect.annotateLogs({ clientId, rebaseId, operation: "rebase" }),
					Effect.withSpan("SyncService.rebase", { attributes: { clientId, rebaseId } })
				)
			)
		)

	return { hardResync, rebase } as const
}
