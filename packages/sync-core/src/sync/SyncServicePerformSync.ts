import type { SqlClient } from "@effect/sql"
import { Effect, Option, Schedule } from "effect"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ClientClockState } from "../ClientClockState"
import { compareClock, sortClocks } from "../ClockOrder"
import { ActionRecord } from "../models"
import { ingestRemoteSyncLogBatch } from "../SyncLogIngest"
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

	/**
	 * Applied-cursor helper: compute the maximum `server_ingest_id` among remote (other-client)
	 * actions that are already incorporated into the local materialized state.
	 *
	 * We treat `last_seen_server_ingest_id` as an "applied" watermark (not merely ingested):
	 * - safe to use as `basisServerIngestId` for upload gating (under the honest-client assumption)
	 * - does not advance past ingested-but-unapplied remote actions (e.g. concurrent Electric ingest)
	 */
	const getMaxAppliedRemoteServerIngestId = () =>
		sqlClient<{ readonly max_server_ingest_id: number | string | null }>`
			SELECT COALESCE(MAX(ar.server_ingest_id), 0) AS max_server_ingest_id
			FROM action_records ar
			JOIN local_applied_action_ids la ON la.action_record_id = ar.id
			WHERE ar.synced = 1
			AND ar.server_ingest_id IS NOT NULL
			AND ar.client_id != ${clientId}
		`.pipe(
			Effect.map((rows) => {
				const raw = rows[0]?.max_server_ingest_id ?? 0
				const parsed = typeof raw === "number" ? raw : Number(raw)
				return Number.isFinite(parsed) ? parsed : 0
			})
		)

	const advanceAppliedRemoteServerIngestCursor = () =>
		getMaxAppliedRemoteServerIngestId().pipe(
			Effect.flatMap((maxApplied) => clockState.advanceLastSeenServerIngestId(maxApplied))
		)

	const reconcile = (
		pendingActions: readonly ActionRecord[],
		remoteActions: readonly ActionRecord[],
		allLocalActions: readonly ActionRecord[]
	) =>
		Effect.gen(function* () {
			yield* Effect.logInfo(
				`Performing reconciliation. Pending: [${pendingActions.map((a) => `${a.id} (${a._tag})`).join(", ")}], Remote: [${remoteActions.map((a) => `${a.id} (${a._tag})`).join(", ")}]`
			)
			yield* Effect.logDebug(
				`All local actions provided to reconcile: [${allLocalActions.map((a) => `${a.id} (${a._tag})`).join(", ")}]`
			)

			// Roll back to common ancestor, passing all local actions for context
			const commonAncestorOpt = yield* rollbackToCommonAncestor().pipe(
				Effect.map(Option.fromNullable)
			)
			const commonAncestor = Option.getOrNull(commonAncestorOpt)
			yield* Effect.logDebug(
				`Rolled back to common ancestor during reconcile: ${JSON.stringify(commonAncestor)}`
			)
			const rollbackClock = yield* clockState.incrementClock
			// even if the actual DB rollback happened in the SQL function's implicit transaction.
			const rollbackTransactionId = Date.now()
			const rollbackActionRecord = yield* actionRecordRepo.insert(
				ActionRecord.insert.make({
					id: crypto.randomUUID(),
					_tag: "RollbackAction",
					client_id: clientId,
					clock: rollbackClock,
					args: {
						target_action_id: commonAncestor?.id ?? null,
						timestamp: rollbackClock.timestamp
					},
					synced: false,
					created_at: new Date(),
					transaction_id: rollbackTransactionId
				})
			)
			yield* Effect.logInfo(`Created RollbackAction record: ${rollbackActionRecord.id}`)

			const actionsToReplay = yield* actionRecordRepo.findUnappliedLocally()
			yield* Effect.logDebug(
				`Final list of actions to REPLAY in reconcile: [${actionsToReplay.map((a: ActionRecord) => `${a.id} (${a._tag})`).join(", ")}]`
			)
			yield* applyActionRecords(actionsToReplay)
			return yield* actionRecordRepo.allUnsynced()
		}).pipe(
			Effect.annotateLogs({ clientId, operation: "reconcile" }),
			Effect.withSpan("SyncService.reconcile", { attributes: { clientId } })
		)

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

						// 2. Remote ingress (transport-specific).
						//
						// Transports deliver remote sync-log rows; `sync-core` owns the ingestion step
						// (idempotent persistence into `action_records` / `action_modified_rows`).
						//
						// Electric-enabled clients typically return no action rows here (metadata-only) because
						// their authoritative ingress is the Electric stream.
						const fetched = yield* syncNetworkService.fetchRemoteActions().pipe(
							Effect.withSpan("SyncNetworkService.fetchRemoteActions", {
								attributes: { clientId, syncSessionId }
							})
						)
						const localEpoch = yield* clockState.getServerEpoch
						if (localEpoch === null) {
							yield* clockState.setServerEpoch(fetched.serverEpoch)
						} else if (localEpoch !== fetched.serverEpoch) {
							return yield* Effect.fail(
								new SyncHistoryEpochMismatch({
									message:
										"Server sync history epoch mismatch (server reset/restore or breaking migration)",
									localEpoch,
									serverEpoch: fetched.serverEpoch
								})
							)
						}
						if (lastSeenServerIngestId + 1 < fetched.minRetainedServerIngestId) {
							return yield* Effect.fail(
								new FetchRemoteActionsCompacted({
									message:
										"Client cursor is older than the server's retained action log history (compacted)",
									sinceServerIngestId: lastSeenServerIngestId,
									minRetainedServerIngestId: fetched.minRetainedServerIngestId,
									serverEpoch: fetched.serverEpoch
								})
							)
						}

						yield* ingestRemoteSyncLogBatch(sqlClient, {
							actions: fetched.actions,
							modifiedRows: fetched.modifiedRows
						})
						yield* Effect.logInfo("performSync.remoteIngress", {
							fetchedActionCount: fetched.actions.length,
							fetchedAmrCount: fetched.modifiedRows.length
						})

						// Remote apply is DB-driven: treat `action_records` as the authoritative ingress queue.
						// This enables Electric/custom transports to populate the tables without relying on
						// the RPC fetch return value.
						const remoteActions = yield* actionRecordRepo.findSyncedButUnapplied()
						yield* Effect.logInfo("performSync.remoteUnapplied", {
							count: remoteActions.length,
							actions: remoteActions.map((a) => ({
								id: a.id,
								_tag: a._tag,
								client_id: a.client_id,
								server_ingest_id: a.server_ingest_id
							}))
						})

						// Remote actions must have their patches ingested before we can safely apply:
						// - rollback correctness requires reverse patches for applied actions
						// - divergence detection requires comparing replay patches vs. original patches
						// If ingress is mid-flight (e.g. action_records arrived before action_modified_rows),
						// bail out and retry later rather than creating spurious outgoing SYNC deltas.
						const remoteIdsNeedingPatches = remoteActions
							.filter((a) => a._tag !== "RollbackAction")
							.map((a) => a.id)
						if (remoteIdsNeedingPatches.length > 0) {
							const idsWithPatches = yield* sqlClient<{ readonly action_record_id: string }>`
								SELECT DISTINCT action_record_id
								FROM action_modified_rows
								WHERE action_record_id IN ${sqlClient.in(remoteIdsNeedingPatches)}
							`
							const havePatches = new Set(idsWithPatches.map((r) => r.action_record_id))
							const missingPatchActionIds = remoteIdsNeedingPatches.filter(
								(id) => havePatches.has(id) === false
							)
							if (missingPatchActionIds.length > 0) {
								yield* Effect.logInfo("performSync.remoteNotReady.missingPatches", {
									missingPatchActionCount: missingPatchActionIds.length,
									missingPatchActionIds: missingPatchActionIds.slice(0, 20)
								})
								return [] as const
							}
						}

						const hasPending = pendingActions.length > 0
						const hasRemote = remoteActions.length > 0
						if (!hasPending && !hasRemote) {
							yield* Effect.logInfo("performSync.noop")
							yield* advanceAppliedRemoteServerIngestCursor()
							return [] as const
						}
						if (!hasPending && hasRemote) {
							yield* Effect.logInfo("performSync.case1.applyRemote", {
								remoteCount: remoteActions.length
							})
							const rollbackActions = remoteActions.filter((a) => a._tag === "RollbackAction")
							const unappliedNonRollback = remoteActions.filter((a) => a._tag !== "RollbackAction")

							let forcedRollbackTarget: string | null | undefined = undefined
							if (rollbackActions.length > 0) {
								const targets = rollbackActions.map(
									(rb) => rb.args["target_action_id"] as string | null
								)
								const hasGenesis = targets.some((t) => t === null)
								if (hasGenesis) {
									forcedRollbackTarget = null
								} else {
									const targetIds = targets.filter(
										(t): t is string => typeof t === "string" && t.length > 0
									)
									if (targetIds.length > 0) {
										const targetRows = yield* sqlClient<{
											readonly id: string
											readonly clock: ActionRecord["clock"]
											readonly client_id: string
										}>`
											SELECT id, clock, client_id
											FROM action_records
											WHERE id IN ${sqlClient.in(targetIds)}
										`
										if (targetRows.length !== targetIds.length) {
											return yield* Effect.fail(
												new SyncError({
													message: `Rollback target action(s) not found locally: ${targetIds.join(", ")}`
												})
											)
										}
										const oldest = [...targetRows]
											.map((a) => ({ ...a, clientId: a.client_id }))
											.sort((a, b) =>
												compareClock(
													{ clock: a.clock, clientId: a.clientId, id: a.id },
													{ clock: b.clock, clientId: b.clientId, id: b.id }
												)
											)[0]
										forcedRollbackTarget = oldest?.id
									}
								}
							}

							const latestApplied = yield* sqlClient<{
								readonly id: string
								readonly clock_time_ms: number | string
								readonly clock_counter: number | string
								readonly client_id: string
							}>`
								SELECT ar.id, ar.clock_time_ms, ar.clock_counter, ar.client_id
								FROM action_records ar
								JOIN local_applied_action_ids la ON la.action_record_id = ar.id
								ORDER BY ar.clock_time_ms DESC, ar.clock_counter DESC, ar.client_id DESC, ar.id DESC
								LIMIT 1
							`.pipe(Effect.map((rows) => rows[0] ?? null))

							const earliestRemote = unappliedNonRollback.length
								? sortClocks(
										unappliedNonRollback.map((a) => ({
											action: a,
											clock: a.clock,
											clientId: a.client_id,
											id: a.id
										}))
									)[0]?.action
								: undefined

							const needsRollbackForLateArrival =
								latestApplied && earliestRemote
									? compareClock(
											{
												clock: earliestRemote.clock,
												clientId: earliestRemote.client_id,
												id: earliestRemote.id
											},
											{
												clock: {
													timestamp: Number(latestApplied.clock_time_ms),
													vector: {
														[latestApplied.client_id]: Number(latestApplied.clock_counter)
													}
												},
												clientId: latestApplied.client_id,
												id: latestApplied.id
											}
										) <= 0
									: false

							let rollbackTarget: string | null | undefined = forcedRollbackTarget
							if (rollbackTarget === undefined && needsRollbackForLateArrival && earliestRemote) {
								const predecessor = yield* sqlClient<{ readonly id: string }>`
									SELECT id
									FROM action_records
									WHERE (clock_time_ms, clock_counter, client_id, id) < (
										${earliestRemote.clock_time_ms},
										${earliestRemote.clock_counter},
										${earliestRemote.client_id},
										${earliestRemote.id}
									)
									ORDER BY clock_time_ms DESC, clock_counter DESC, client_id DESC, id DESC
									LIMIT 1
								`
								rollbackTarget = predecessor[0]?.id ?? null
							}

							if (rollbackTarget !== undefined) {
								yield* Effect.logInfo("performSync.case1.rematerialize", {
									remoteCount: remoteActions.length,
									rollbackTarget: rollbackTarget ?? null,
									hasRollbackAction: rollbackActions.length > 0,
									lateArrival: forcedRollbackTarget === undefined && needsRollbackForLateArrival
								})

								yield* rollbackToAction(rollbackTarget).pipe(sqlClient.withTransaction)
								for (const rb of rollbackActions) {
									yield* actionRecordRepo.markLocallyApplied(rb.id)
								}

								const actionsToReplay = yield* actionRecordRepo.findUnappliedLocally()
								const replayWithoutRollbacks = actionsToReplay.filter(
									(a) => a._tag !== "RollbackAction"
								)
								if (replayWithoutRollbacks.length > 0) {
									yield* applyActionRecords(replayWithoutRollbacks)
								}

								yield* advanceAppliedRemoteServerIngestCursor()
								if (!uploadsDisabled) {
									yield* sendLocalActions()
								}
								return remoteActions
							}

							// Fast-forward: apply only newly received non-rollback actions in canonical order.
							if (unappliedNonRollback.length > 0) {
								yield* applyActionRecords(unappliedNonRollback)
							}
							yield* advanceAppliedRemoteServerIngestCursor()
							if (!uploadsDisabled) {
								yield* sendLocalActions()
							}
							return remoteActions
						}
						if (hasPending && !hasRemote) {
							yield* Effect.logInfo("performSync.case2.sendPending", {
								pendingCount: pendingActions.length
							})
							yield* advanceAppliedRemoteServerIngestCursor()
							return uploadsDisabled ? ([] as const) : yield* sendLocalActions()
						}
						if (hasPending && hasRemote) {
							const sortedPending = sortClocks(
								pendingActions.map((a) => ({
									action: a,
									clock: a.clock,
									clientId: a.client_id,
									id: a.id
								}))
							)
							const sortedRemote = sortClocks(
								remoteActions.map((a) => ({
									action: a,
									clock: a.clock,
									clientId: a.client_id,
									id: a.id
								}))
							)

							const latestPendingAction = sortedPending[sortedPending.length - 1]?.action
							const earliestRemoteAction = sortedRemote[0]?.action

							if (latestPendingAction && earliestRemoteAction) {
								if (
									!remoteActions.find((a) => a._tag === "RollbackAction") &&
									compareClock(
										{
											clock: latestPendingAction.clock,
											clientId: latestPendingAction.client_id,
											id: latestPendingAction.id
										},
										{
											clock: earliestRemoteAction.clock,
											clientId: earliestRemoteAction.client_id,
											id: earliestRemoteAction.id
										}
									) < 0
								) {
									yield* Effect.logInfo("performSync.case4.applyRemoteThenSendPending", {
										latestPendingActionId: latestPendingAction.id,
										earliestRemoteActionId: earliestRemoteAction.id,
										pendingCount: pendingActions.length,
										remoteCount: remoteActions.length
									})

									// 1. Apply remote actions
									const appliedRemotes = yield* applyActionRecords(remoteActions)
									yield* advanceAppliedRemoteServerIngestCursor()
									// 2. Send pending actions
									if (!uploadsDisabled) {
										yield* sendLocalActions()
									}
									// For now, returning applied remotes as they were processed first in this flow.
									return appliedRemotes
								} else {
									yield* Effect.logInfo("performSync.case3.reconcileThenSendPending", {
										pendingCount: pendingActions.length,
										remoteCount: remoteActions.length
									})
									const allLocalActions = yield* actionRecordRepo.all()
									yield* reconcile(pendingActions, remoteActions, allLocalActions)
									yield* advanceAppliedRemoteServerIngestCursor()
									return uploadsDisabled ? ([] as const) : yield* sendLocalActions()
								}
							} else {
								return yield* Effect.fail(
									new SyncError({
										message: "Could not determine latest pending or earliest remote clock."
									})
								)
							}
						}
						return yield* Effect.dieMessage("Unreachable code reached in performSync")
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
