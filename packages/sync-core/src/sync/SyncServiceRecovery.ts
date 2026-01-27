import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { ActionModifiedRow } from "../models"
import { ActionRecord } from "../models"
import type { ActionModifiedRowRepo } from "../ActionModifiedRowRepo"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ActionRegistry } from "../ActionRegistry"
import type { ClientClockState } from "../ClientClockState"
import type { ClientDbAdapterService } from "../ClientDbAdapter"
import type { DeterministicId } from "../DeterministicId"
import { applyForwardAmrs } from "../PatchApplier"
import { bindJsonParam } from "../SqlJson"
import { SyncError } from "../SyncServiceErrors"
import type { SyncNetworkService } from "../SyncNetworkService"
import type { BootstrapSnapshot } from "./SyncServiceBootstrap"

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

	const hardResync = () =>
		newTraceId.pipe(
			Effect.flatMap((resyncId) =>
				Effect.gen(function* () {
					yield* Effect.logInfo("hardResync.start", { resyncId, clientId })

					const snapshot = yield* syncNetworkService.fetchBootstrapSnapshot().pipe(
						Effect.mapError(
							(error) =>
								new SyncError({
									message: error instanceof Error ? error.message : String(error),
									cause: error
								})
						)
					)

					yield* clientDbAdapter
						.withCaptureContext(
							null,
							clientDbAdapter.withPatchTrackingDisabled(
								Effect.gen(function* () {
									yield* Effect.logInfo("hardResync.clearSyncTables", { resyncId, clientId })
									yield* sqlClient`DELETE FROM action_modified_rows`.pipe(Effect.asVoid)
									yield* sqlClient`DELETE FROM action_records`.pipe(Effect.asVoid)
									yield* sqlClient`DELETE FROM local_applied_action_ids`.pipe(Effect.asVoid)
									yield* sqlClient`DELETE FROM local_quarantined_actions`.pipe(Effect.asVoid)
								})
							)
						)
						.pipe(sqlClient.withTransaction)

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

					const snapshot = yield* syncNetworkService.fetchBootstrapSnapshot().pipe(
						Effect.mapError(
							(error) =>
								new SyncError({
									message: error instanceof Error ? error.message : String(error),
									cause: error
								})
						)
					)

					yield* Effect.logInfo("rebase.snapshot.received", {
						rebaseId,
						clientId,
						serverIngestId: snapshot.serverIngestId,
						tableCount: snapshot.tables.length
					})

					yield* Effect.gen(function* () {
						const pendingActions = yield* actionRecordRepo.allUnsyncedActive()

						const pendingSyncActionIds = pendingActions
							.filter((a) => a._tag === "_InternalSyncApply")
							.map((a) => a.id)

						const pendingSyncAmrs =
							pendingSyncActionIds.length === 0
								? ([] as const)
								: yield* actionModifiedRowRepo.findByActionRecordIds(pendingSyncActionIds)

						const pendingSyncAmrsByActionId = new Map<string, readonly ActionModifiedRow[]>()
						{
							const buckets = new Map<string, ActionModifiedRow[]>()
							for (const amr of pendingSyncAmrs) {
								const existing = buckets.get(amr.action_record_id) ?? []
								existing.push(amr)
								buckets.set(amr.action_record_id, existing)
							}
							for (const [actionId, rows] of buckets) {
								pendingSyncAmrsByActionId.set(actionId, rows)
							}
						}

						yield* Effect.logInfo("rebase.pending", {
							rebaseId,
							clientId,
							pendingActionCount: pendingActions.length,
							pendingSyncActionCount: pendingSyncActionIds.length,
							pendingSyncAmrCount: pendingSyncAmrs.length
						})

						yield* clientDbAdapter.withCaptureContext(
							null,
							clientDbAdapter.withPatchTrackingDisabled(
								Effect.gen(function* () {
									yield* sqlClient`DELETE FROM action_modified_rows`.pipe(Effect.asVoid)
									yield* sqlClient`DELETE FROM action_records`.pipe(Effect.asVoid)
									yield* sqlClient`DELETE FROM local_applied_action_ids`.pipe(Effect.asVoid)
									yield* sqlClient`DELETE FROM local_quarantined_actions`.pipe(Effect.asVoid)
								})
							)
						)

						yield* applyBootstrapSnapshotInTx(snapshot)

						for (const pending of pendingActions) {
							const nextClock = yield* clockState.incrementClock

							yield* actionRecordRepo.insert(
								ActionRecord.insert.make({
									id: pending.id,
									client_id: clientId,
									clock: nextClock,
									_tag: pending._tag,
									args: pending.args,
									created_at: pending.created_at,
									synced: false,
									transaction_id: pending.transaction_id,
									user_id: pending.user_id ?? null
								})
							)

							if (pending._tag === "_InternalSyncApply") {
								const syncAmrs = pendingSyncAmrsByActionId.get(pending.id) ?? []

								for (const amr of syncAmrs) {
									yield* sqlClient`
										INSERT INTO action_modified_rows ${sqlClient.insert({
											id: amr.id,
											table_name: amr.table_name,
											row_id: amr.row_id,
											action_record_id: amr.action_record_id,
											audience_key: amr.audience_key,
											operation: amr.operation,
											forward_patches: bindJsonParam(sqlClient, amr.forward_patches),
											reverse_patches: bindJsonParam(sqlClient, amr.reverse_patches),
											sequence: amr.sequence
										})}
										ON CONFLICT (id) DO NOTHING
									`.pipe(Effect.asVoid)
								}

								if (syncAmrs.length > 0) {
									yield* clientDbAdapter.withCaptureContext(
										null,
										clientDbAdapter.withPatchTrackingDisabled(
											applyForwardAmrs(syncAmrs).pipe(
												Effect.provideService(SqlClient.SqlClient, sqlClient)
											)
										)
									)
								}

								yield* actionRecordRepo.markLocallyApplied(pending.id)
								continue
							}

							if (pending._tag === "RollbackAction") {
								yield* actionRecordRepo.markLocallyApplied(pending.id)
								continue
							}

							const actionCreator = actionRegistry.getActionCreator(pending._tag)
							if (!actionCreator) {
								return yield* Effect.fail(
									new SyncError({
										message: `Missing action creator: ${pending._tag}`
									})
								)
							}

							yield* clientDbAdapter.withCaptureContext(
								pending.id,
								deterministicId.withActionContext(pending.id, actionCreator(pending.args).execute())
							)

							yield* actionRecordRepo.markLocallyApplied(pending.id)
						}
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
