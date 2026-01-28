/**
 * SyncService "performSync" orchestrator.
 *
 * Coordinates the full sync loop:
 * - remote ingress + readiness checks (transport fetch + core-owned ingestion)
 * - case selection (remote-only / pending-only / reconcile / etc)
 * - upload gating (quarantine) and applied-cursor advancement
 *
 * Complex subroutines are split out to make the main flow readable:
 * - `SyncServicePerformSyncRemoteIngress` (fetch + ingest + apply-readiness checks)
 * - `SyncServicePerformSyncCases` (decision tree for sync strategies)
 * - `SyncServicePerformSyncAppliedCursor` (applied remote cursor computation)
 */
import type { SqlClient } from "@effect/sql"
import { Effect, Schedule } from "effect"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ClientClockState } from "../ClientClockState"
import type { ActionRecord } from "../models"
import {
	FetchRemoteActionsCompacted,
	NetworkRequestError,
	RemoteActionFetchError,
	SendLocalActionsBehindHead,
	SendLocalActionsDenied,
	SendLocalActionsInternal,
	SendLocalActionsInvalid,
	SyncHistoryEpochMismatch,
	type SyncNetworkService
} from "../SyncNetworkService"
import { SyncError } from "../SyncServiceErrors"
import type { BootstrapSnapshot } from "./SyncServiceBootstrap"
import { makeAppliedRemoteCursor } from "./SyncServicePerformSyncAppliedCursor"
import { makePerformSyncCases } from "./SyncServicePerformSyncCases"
import { fetchIngestAndListRemoteActions } from "./SyncServicePerformSyncRemoteIngress"

export const makePerformSync = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly clockState: ClientClockState
	readonly actionRecordRepo: ActionRecordRepo
	readonly syncNetworkService: SyncNetworkService
	readonly clientId: string
	readonly newTraceId: Effect.Effect<string>
	readonly applyBootstrapSnapshot: (
		snapshot: BootstrapSnapshot
	) => Effect.Effect<void, unknown, never>
	readonly rollbackToAction: (targetActionId: string | null) => Effect.Effect<void, unknown, never>
	readonly rollbackToCommonAncestor: () => Effect.Effect<ActionRecord | null, unknown, never>
	readonly applyActionRecords: (
		remoteActions: readonly ActionRecord[]
	) => Effect.Effect<readonly ActionRecord[], unknown, never>
	readonly sendLocalActions: () => Effect.Effect<
		readonly ActionRecord[],
		| SendLocalActionsBehindHead
		| SendLocalActionsDenied
		| SendLocalActionsInvalid
		| SendLocalActionsInternal
		| NetworkRequestError
		| SyncError,
		never
	>
	readonly hardResync: () => Effect.Effect<void, unknown, never>
	readonly rebase: () => Effect.Effect<void, unknown, never>
	readonly quarantineUnsyncedActions: (
		failure: SendLocalActionsDenied | SendLocalActionsInvalid
	) => Effect.Effect<number, SyncError, never>
}) => {
	const {
		sqlClient,
		clockState,
		actionRecordRepo,
		syncNetworkService,
		clientId,
		newTraceId,
		applyBootstrapSnapshot,
		rollbackToAction,
		rollbackToCommonAncestor,
		applyActionRecords,
		sendLocalActions,
		hardResync,
		rebase,
		quarantineUnsyncedActions
	} = deps

	const { advanceAppliedRemoteServerIngestCursor } = makeAppliedRemoteCursor({
		sqlClient,
		clockState,
		clientId
	})

	/**
	 * synchronize with the server
	 * Fetches pending local actions and unseen remote actions, then determines the appropriate sync strategy:
	 * - Case 1: No local pending, apply remote actions.
	 * - Case 2: No remote actions, send local pending actions.
	 * - Case 3: Both local and remote actions exist, perform reconciliation.
	 * Returns the actions that were effectively processed (applied, sent, or reconciled).
	 */
	const performSync = () => performSyncWithPolicy(true, true)

	type PerformSyncResult = readonly ActionRecord[]
	type PerformSyncError =
		| SendLocalActionsBehindHead
		| SendLocalActionsInternal
		| NetworkRequestError
		| FetchRemoteActionsCompacted
		| RemoteActionFetchError
		| SyncHistoryEpochMismatch
		| SyncError

	const performSyncWithPolicy = (
		allowInvalidRebase: boolean,
		allowDiscontinuityRecovery: boolean
	): Effect.Effect<PerformSyncResult, PerformSyncError, never> =>
		newTraceId
			.pipe(
				Effect.flatMap((syncSessionId) =>
					Effect.gen(function* () {
						yield* Effect.logInfo("performSync.start", { syncSessionId })
						const quarantineRows = yield* sqlClient<{ readonly count: number | string }>`
							SELECT count(*) as count FROM local_quarantined_actions
						`
						const quarantinedCountRaw = quarantineRows[0]?.count ?? 0
						const quarantinedCount =
							typeof quarantinedCountRaw === "number"
								? quarantinedCountRaw
								: Number(quarantinedCountRaw ?? 0)
						const uploadsDisabled = quarantinedCount > 0
						if (uploadsDisabled) {
							yield* Effect.logWarning("performSync.uploadsDisabled.quarantined", {
								syncSessionId,
								quarantinedCount
							})
						}
						// Ensure `client_sync_status` exists before reading cursor state (last_seen_server_ingest_id, etc).
						const lastSeenServerIngestIdBeforeBootstrap =
							yield* clockState.getLastSeenServerIngestId
						yield* Effect.logDebug("performSync.cursor.beforeBootstrap", {
							lastSeenServerIngestId: lastSeenServerIngestIdBeforeBootstrap
						})

						const bootstrapFromSnapshotIfNeeded = () =>
							Effect.gen(function* () {
								if (lastSeenServerIngestIdBeforeBootstrap > 0) return false

								const [localState] = yield* sqlClient<{
									readonly has_any_action_records: boolean | 0 | 1
								}>`
									SELECT EXISTS (SELECT 1 FROM action_records LIMIT 1) as has_any_action_records
								`
								const hasAnyActionRecords =
									typeof localState?.has_any_action_records === "boolean"
										? localState.has_any_action_records
										: localState?.has_any_action_records === 1
								if (hasAnyActionRecords) return false

								yield* Effect.logInfo("performSync.bootstrap.start", { clientId })
								const snapshot = yield* syncNetworkService.fetchBootstrapSnapshot()
								yield* Effect.logInfo("performSync.bootstrap.received", {
									clientId,
									serverIngestId: snapshot.serverIngestId,
									tableCount: snapshot.tables.length,
									rowCounts: snapshot.tables.map((t) => ({
										tableName: t.tableName,
										rowCount: t.rows.length
									}))
								})

								yield* applyBootstrapSnapshot(snapshot)

								yield* Effect.logInfo("performSync.bootstrap.done", {
									clientId,
									serverIngestId: snapshot.serverIngestId
								})

								return true
							}).pipe(
								Effect.catchAll((error) =>
									Effect.logWarning("performSync.bootstrap.failed", {
										clientId,
										message: error instanceof Error ? error.message : String(error)
									}).pipe(Effect.as(false))
								)
							)

						yield* bootstrapFromSnapshotIfNeeded()
						const lastSeenServerIngestId = yield* clockState.getLastSeenServerIngestId
						yield* Effect.logDebug("performSync.cursor.afterBootstrap", {
							lastSeenServerIngestId
						})
						// 1. Get pending local actions
						const pendingActions = uploadsDisabled
							? ([] as const)
							: yield* actionRecordRepo.findBySynced(false)
						yield* Effect.logDebug("performSync.pendingActions", {
							count: pendingActions.length,
							actions: pendingActions.map((a) => ({
								id: a.id,
								_tag: a._tag,
								client_id: a.client_id
							}))
						})

						const remoteReadiness = yield* fetchIngestAndListRemoteActions({
							sqlClient,
							clockState,
							actionRecordRepo,
							syncNetworkService,
							clientId,
							syncSessionId,
							lastSeenServerIngestId
						})
						if (remoteReadiness._tag === "RemoteNotReady") {
							return [] as const
						}

						const { run } = makePerformSyncCases({
							sqlClient,
							clockState,
							actionRecordRepo,
							clientId,
							uploadsDisabled,
							rollbackToAction,
							rollbackToCommonAncestor,
							applyActionRecords,
							sendLocalActions,
							advanceAppliedRemoteServerIngestCursor
						})

						return yield* run(pendingActions, remoteReadiness.remoteActions)
					}).pipe(
						Effect.tapError((error) => {
							if (error instanceof SendLocalActionsBehindHead) {
								return Effect.logWarning("performSync.behindHead", {
									syncSessionId,
									clientId,
									basisServerIngestId: error.basisServerIngestId,
									firstUnseenServerIngestId: error.firstUnseenServerIngestId,
									firstUnseenActionId: error.firstUnseenActionId ?? null
								})
							}
							const errorTag =
								typeof error === "object" && error !== null
									? ((error as { readonly _tag?: unknown })._tag ?? null)
									: null
							return Effect.logError("performSync.failed", {
								syncSessionId,
								clientId,
								errorTag: typeof errorTag === "string" ? errorTag : null,
								message: error instanceof Error ? error.message : String(error)
							})
						}),
						Effect.retry(
							Schedule.recurs(3).pipe(
								Schedule.whileInput((error) => error instanceof SendLocalActionsBehindHead)
							)
						),
						Effect.catchAll((error) => {
							if (
								error instanceof SendLocalActionsBehindHead ||
								error instanceof SendLocalActionsDenied ||
								error instanceof SendLocalActionsInvalid ||
								error instanceof SendLocalActionsInternal ||
								error instanceof NetworkRequestError ||
								error instanceof FetchRemoteActionsCompacted ||
								error instanceof RemoteActionFetchError ||
								error instanceof SyncHistoryEpochMismatch ||
								error instanceof SyncError
							) {
								return Effect.fail(error)
							}
							const message = error instanceof Error ? error.message : String(error)
							return Effect.fail(
								new SyncError({ message: `Sync failed: ${message}`, cause: error })
							)
						}),
						Effect.annotateLogs({ clientId, syncSessionId }),
						Effect.withSpan("SyncService.performSync", {
							attributes: { clientId, syncSessionId }
						})
					)
				)
			)
			.pipe(
				Effect.catchTag(
					"SendLocalActionsDenied",
					(error): Effect.Effect<PerformSyncResult, PerformSyncError, never> =>
						quarantineUnsyncedActions(error).pipe(Effect.as([] as const))
				),
				Effect.catchTag(
					"SendLocalActionsInvalid",
					(error): Effect.Effect<PerformSyncResult, PerformSyncError, never> => {
						if (!allowInvalidRebase) {
							return quarantineUnsyncedActions(error).pipe(Effect.as([] as const))
						}

						return Effect.logWarning("performSync.invalid.rebaseOnce", {
							clientId,
							message: error.message,
							code: error.code ?? null
						}).pipe(
							Effect.zipRight(
								rebase().pipe(
									Effect.catchAll((rebaseError) =>
										Effect.logError("performSync.invalid.rebaseFailed", {
											clientId,
											message:
												rebaseError instanceof Error ? rebaseError.message : String(rebaseError)
										}).pipe(Effect.asVoid)
									)
								)
							),
							Effect.zipRight(performSyncWithPolicy(false, allowDiscontinuityRecovery))
						)
					}
				),
				Effect.catchTag(
					"SyncHistoryEpochMismatch",
					(error): Effect.Effect<PerformSyncResult, PerformSyncError, never> =>
						Effect.gen(function* () {
							const quarantineRows = yield* sqlClient<{ readonly count: number | string }>`
								SELECT count(*) as count FROM local_quarantined_actions
							`
							const quarantinedCountRaw = quarantineRows[0]?.count ?? 0
							const quarantinedCount =
								typeof quarantinedCountRaw === "number"
									? quarantinedCountRaw
									: Number(quarantinedCountRaw ?? 0)
							if (quarantinedCount > 0) {
								return yield* Effect.fail(
									new SyncError({
										message:
											"Sync history changed while local actions are quarantined; app must resolve (discard or hard resync)",
										cause: error
									})
								)
							}

							if (!allowDiscontinuityRecovery) {
								return yield* Effect.fail(
									new SyncError({
										message:
											"Sync history epoch mismatch persists after recovery attempt; app must hard resync",
										cause: error
									})
								)
							}

							const pending = yield* actionRecordRepo.allUnsyncedActive()
							if (pending.length === 0) {
								yield* Effect.logWarning("performSync.epochMismatch.hardResync", {
									clientId,
									localEpoch: error.localEpoch,
									serverEpoch: error.serverEpoch
								})
								yield* hardResync()
							} else {
								yield* Effect.logWarning("performSync.epochMismatch.rebase", {
									clientId,
									pendingCount: pending.length,
									localEpoch: error.localEpoch,
									serverEpoch: error.serverEpoch
								})
								yield* rebase()
							}

							return yield* performSyncWithPolicy(allowInvalidRebase, false)
						}).pipe(
							Effect.catchAll((unknownError) =>
								unknownError instanceof SendLocalActionsBehindHead ||
								unknownError instanceof SendLocalActionsInternal ||
								unknownError instanceof NetworkRequestError ||
								unknownError instanceof RemoteActionFetchError ||
								unknownError instanceof FetchRemoteActionsCompacted ||
								unknownError instanceof SyncHistoryEpochMismatch ||
								unknownError instanceof SyncError
									? Effect.fail(unknownError)
									: Effect.fail(
											new SyncError({
												message: "Failed while handling sync epoch mismatch",
												cause: unknownError
											})
										)
							)
						)
				),
				Effect.catchTag(
					"FetchRemoteActionsCompacted",
					(error): Effect.Effect<PerformSyncResult, PerformSyncError, never> =>
						Effect.gen(function* () {
							const quarantineRows = yield* sqlClient<{ readonly count: number | string }>`
								SELECT count(*) as count FROM local_quarantined_actions
							`
							const quarantinedCountRaw = quarantineRows[0]?.count ?? 0
							const quarantinedCount =
								typeof quarantinedCountRaw === "number"
									? quarantinedCountRaw
									: Number(quarantinedCountRaw ?? 0)
							if (quarantinedCount > 0) {
								return yield* Effect.fail(
									new SyncError({
										message:
											"Server history was compacted while local actions are quarantined; app must resolve (discard or hard resync)",
										cause: error
									})
								)
							}

							if (!allowDiscontinuityRecovery) {
								return yield* Effect.fail(
									new SyncError({
										message:
											"Server history compaction requires resync; recovery attempt did not resolve it",
										cause: error
									})
								)
							}

							const pending = yield* actionRecordRepo.allUnsyncedActive()
							if (pending.length === 0) {
								yield* Effect.logWarning("performSync.historyCompacted.hardResync", {
									clientId,
									sinceServerIngestId: error.sinceServerIngestId,
									minRetainedServerIngestId: error.minRetainedServerIngestId
								})
								yield* hardResync()
							} else {
								yield* Effect.logWarning("performSync.historyCompacted.rebase", {
									clientId,
									pendingCount: pending.length,
									sinceServerIngestId: error.sinceServerIngestId,
									minRetainedServerIngestId: error.minRetainedServerIngestId
								})
								yield* rebase()
							}

							return yield* performSyncWithPolicy(allowInvalidRebase, false)
						}).pipe(
							Effect.catchAll((unknownError) =>
								unknownError instanceof SendLocalActionsBehindHead ||
								unknownError instanceof SendLocalActionsInternal ||
								unknownError instanceof NetworkRequestError ||
								unknownError instanceof RemoteActionFetchError ||
								unknownError instanceof FetchRemoteActionsCompacted ||
								unknownError instanceof SyncHistoryEpochMismatch ||
								unknownError instanceof SyncError
									? Effect.fail(unknownError)
									: Effect.fail(
											new SyncError({
												message: "Failed while handling server history compaction",
												cause: unknownError
											})
										)
							)
						)
				)
			)

	return { performSync } as const
}
