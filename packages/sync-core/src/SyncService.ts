import { SqlClient, type SqlError } from "@effect/sql"
import { ActionRegistry } from "@synchrotron/sync-core/ActionRegistry"
import { Effect, Option, ParseResult, Schema } from "effect" // Import ReadonlyArray
import { ActionModifiedRowRepo, compareActionModifiedRows } from "./ActionModifiedRowRepo"
import { ActionRecordRepo } from "./ActionRecordRepo"
import { ClientDbAdapter } from "./ClientDbAdapter"
import { ClockService } from "./ClockService"
import { DeterministicId } from "./DeterministicId"
import { Action, ActionModifiedRow, ActionRecord } from "./models" // Import ActionModifiedRow type from models
import { NetworkRequestError, SyncNetworkService } from "./SyncNetworkService"
import { deepObjectEquals } from "./utils"
import { applyForwardAmrs, applyReverseAmrs } from "./PatchApplier"
// Error types
export class ActionExecutionError extends Schema.TaggedError<ActionExecutionError>()(
	"ActionExecutionError",
	{
		actionId: Schema.String,
		cause: Schema.optional(Schema.Unknown)
	}
) {}

export class SyncError extends Schema.TaggedError<SyncError>()("SyncError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Unknown)
}) {}
export class SyncService extends Effect.Service<SyncService>()("SyncService", {
	effect: Effect.gen(function* () {
		const sqlClient = yield* SqlClient.SqlClient
		const clientDbAdapter = yield* ClientDbAdapter
		const clockService = yield* ClockService
		const actionRecordRepo = yield* ActionRecordRepo
		const actionModifiedRowRepo = yield* ActionModifiedRowRepo
			const syncNetworkService = yield* SyncNetworkService
			const clientId = yield* clockService.getNodeId
			const actionRegistry = yield* ActionRegistry
			const deterministicId = yield* DeterministicId

			yield* Effect.logInfo("syncService.start", {
				clientId,
				dbDialect: clientDbAdapter.dialect
			})

			const newTraceId = Effect.sync(() => crypto.randomUUID())
			const valueKind = (value: unknown) =>
				value === null ? "null" : Array.isArray(value) ? "array" : typeof value
			const valuePreview = (value: unknown, maxLength = 300) => {
				try {
					const json = JSON.stringify(value)
					return json.length <= maxLength ? json : `${json.slice(0, maxLength)}…`
				} catch {
					const str = String(value)
					return str.length <= maxLength ? str : `${str.slice(0, maxLength)}…`
				}
			}

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
					Effect.flatMap((maxApplied) => clockService.advanceLastSeenServerIngestId(maxApplied))
				)
		/**
		 * Execute an action and record it for later synchronization
		 *
		 * This will:
		 * 1. Start a transaction
		 * 2. Get the transaction ID
		 * 3. Increment the client's clock
		 * 4. Create an action record
		 * 5. Store the action record
		 * 6. Apply the action (which triggers database changes)
		 * 7. Return the updated action record with patches
		 */
		const executeAction = <A1, A extends Record<string, unknown>, EE, R>(
			action: Action<A1, A, EE, R>
		) =>
				// First wrap everything in a transaction
					Effect.gen(function* () {
						yield* Effect.logInfo(`Executing action: ${action._tag}`)
					// 1. Use an application-level transaction identifier.
					// We do not rely on database-specific transaction IDs (e.g. `txid_current()`), so this works on SQLite.
					const transactionId = Date.now()
					const executionTimestamp = new Date()
					const actionRecordId = crypto.randomUUID()

				const newClock = yield* clockService.incrementClock

				const localClientId = yield* clockService.getNodeId

				const timestampToUse =
					typeof action.args.timestamp === "number"
						? action.args.timestamp
						: executionTimestamp.getTime()

				const argsWithTimestamp: A & { timestamp: number } = {
					...action.args,
					timestamp: timestampToUse
				}
				yield* Effect.logInfo(`inserting new action record for ${action._tag}`)
				const toInsert = ActionRecord.insert.make({
					id: actionRecordId,
					client_id: localClientId,
					clock: newClock,
					_tag: action._tag,
					args: argsWithTimestamp,
					created_at: executionTimestamp,
					synced: false,
					transaction_id: transactionId
				})
				yield* Effect.logInfo(`action record to insert: ${JSON.stringify(toInsert)}`)
				// 5. Store the action record
				const actionRecord = yield* actionRecordRepo
					.insert(toInsert)
					.pipe(
						Effect.tapErrorCause((e) =>
							Effect.logError(`Failed to store action record: ${action._tag}`, e)
						)
					)

				// Provide per-transaction patch-capture context (no-op on Postgres today, required for SQLite later).
				yield* clientDbAdapter.setCaptureContext(actionRecord.id)

				// 6. Apply the action (action-scoped deterministic ID generation is provided via DeterministicId)
				// and will throw an exception if the action fails
				// all changes, including the action record inserted above
				const result = yield* deterministicId.withActionContext(actionRecord.id, action.execute())

				// 7. Fetch the updated action record with patches
				const updatedRecord = yield* actionRecordRepo.findById(actionRecord.id)

				if (Option.isNone(updatedRecord)) {
					return yield* Effect.fail(
						new ActionExecutionError({
							actionId: action._tag,
							cause: new Error(`Failed to retrieve updated action record: ${actionRecord.id}`)
						})
					)
				}
				yield* actionRecordRepo.markLocallyApplied(updatedRecord.value.id)

				return { actionRecord: updatedRecord.value, result }
					}).pipe(
						sqlClient.withTransaction, // Restore transaction wrapper
						Effect.ensuring(clientDbAdapter.setCaptureContext(null).pipe(Effect.orDie)),
						Effect.catchAll((error) =>
							Effect.gen(function* () {
								yield* Effect.logError(`Error during action execution`, error)
								if (error instanceof ActionExecutionError) {
								return yield* Effect.fail(error)
						}

						return yield* Effect.fail(
							new ActionExecutionError({
								actionId: action._tag,
								cause: error
							})
						)
					})
					),
					Effect.annotateLogs({ clientId, actionTag: action._tag }),
					Effect.withSpan("SyncService.executeAction", {
						attributes: { clientId, actionTag: action._tag }
					})
				)

		/**
		 * Rollback to common ancestor state
		 *
		 * This applies the reverse patches in reverse chronological order
		 * to return to the state at the last common ancestor
		 */
		const rollbackToCommonAncestor = () =>
			Effect.gen(function* () {
				const commonAncestor = yield* findCommonAncestor().pipe(Effect.map(Option.getOrNull))
				yield* Effect.logDebug(`Found common ancestor: ${JSON.stringify(commonAncestor)}`)
				yield* rollbackToAction(commonAncestor?.id ?? null)
				return commonAncestor
			}).pipe(
				sqlClient.withTransaction,
				Effect.annotateLogs({ clientId }),
				Effect.withSpan("SyncService.rollbackToCommonAncestor", { attributes: { clientId } })
			)

		const rollbackToAction = (targetActionId: string | null) =>
			Effect.gen(function* () {
				const compareActionRecords = (a: ActionRecord, b: ActionRecord) =>
					clockService.compareClock(
						{ clock: a.clock, clientId: a.client_id, id: a.id },
						{ clock: b.clock, clientId: b.client_id, id: b.id }
					)

				const allActions = yield* actionRecordRepo.all()
				const targetAction = targetActionId
					? yield* actionRecordRepo
							.findById(targetActionId)
							.pipe(
								Effect.flatMap(
									Option.match({
										onNone: () =>
											Effect.fail(
												new SyncError({
													message: `Rollback target action not found: ${targetActionId}`
												})
											),
										onSome: Effect.succeed
									})
								)
							)
					: null

				const actionsAfterTarget = targetAction
					? allActions.filter((a) => compareActionRecords(a, targetAction) > 0)
					: allActions

				if (actionsAfterTarget.length === 0) return

				const appliedIdsRows =
					yield* sqlClient<{ action_record_id: string }>`SELECT action_record_id FROM local_applied_action_ids`
				const appliedIds = new Set(appliedIdsRows.map((r) => r.action_record_id))
				const appliedActionsToRollback = actionsAfterTarget.filter((a) => appliedIds.has(a.id))

				if (appliedActionsToRollback.length === 0) return

				const actionMap = new Map(appliedActionsToRollback.map((a) => [a.id, a]))
				const actionIds = appliedActionsToRollback.map((a) => a.id)
				const amrsToReverse = yield* actionModifiedRowRepo.findByActionRecordIds(actionIds)

				const sortedAmrsToReverse = [...amrsToReverse].sort((a, b) => {
					const actionA = actionMap.get(a.action_record_id)
					const actionB = actionMap.get(b.action_record_id)
					if (!actionA || !actionB) return 0

					const actionOrder = compareActionRecords(actionA, actionB)
					if (actionOrder !== 0) return -actionOrder // reverse (newest first)

					if (a.sequence !== b.sequence) return b.sequence - a.sequence

					return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
				})

				yield* clientDbAdapter.withCaptureContext(
					null,
					clientDbAdapter.withPatchTrackingDisabled(
						applyReverseAmrs(sortedAmrsToReverse).pipe(
							Effect.provideService(SqlClient.SqlClient, sqlClient)
						)
					)
				)

				yield* sqlClient`DELETE FROM local_applied_action_ids WHERE ${sqlClient.in("action_record_id", actionIds)}`
			}).pipe(
				Effect.annotateLogs({ clientId, rollbackTargetActionId: targetActionId ?? "null" }),
				Effect.withSpan("SyncService.rollbackToAction", {
					attributes: { clientId, rollbackTargetActionId: targetActionId ?? "null" }
				})
			)

		/**
		 * synchronize with the server
		 * Fetches pending local actions and unseen remote actions, then determines the appropriate sync strategy:
		 * - Case 1: No local pending, apply remote actions.
		 * - Case 2: No remote actions, send local pending actions.
		 * - Case 3: Both local and remote actions exist, perform reconciliation.
		 * Returns the actions that were effectively processed (applied, sent, or reconciled).
		 */
		const performSync = () =>
			newTraceId.pipe(
					Effect.flatMap((syncSessionId) =>
						Effect.gen(function* () {
							yield* Effect.logInfo("performSync.start", { syncSessionId })
							// Ensure `client_sync_status` exists before reading cursor state (last_seen_server_ingest_id, etc).
							const lastSeenServerIngestId = yield* clockService.getLastSeenServerIngestId
							yield* Effect.logDebug("performSync.cursor", { lastSeenServerIngestId })
							// 1. Get pending local actions
							const pendingActions = yield* actionRecordRepo.findBySynced(false)
							yield* Effect.logDebug("performSync.pendingActions", {
								count: pendingActions.length,
							actions: pendingActions.map((a) => ({ id: a.id, _tag: a._tag, client_id: a.client_id }))
						})

							// 2. Remote ingress (transport-specific). Some implementations also persist the fetched
							// rows into local `action_records` / `action_modified_rows` (RPC fetch+insert, Electric).
							const fetched = yield* syncNetworkService.fetchRemoteActions().pipe(
								Effect.withSpan("SyncNetworkService.fetchRemoteActions", {
									attributes: { clientId, syncSessionId }
								})
							)
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
								return [] as const // Return readonly empty array
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
												.map((a) => ({
													...a,
													clientId: a.client_id
												}))
												.sort((a, b) =>
													clockService.compareClock(
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
									? clockService.sortClocks(
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
										? clockService.compareClock(
												{
													clock: earliestRemote.clock,
													clientId: earliestRemote.client_id,
													id: earliestRemote.id
												},
												{
													clock: { timestamp: Number(latestApplied.clock_time_ms), vector: { [latestApplied.client_id]: Number(latestApplied.clock_counter) } },
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
									return remoteActions
								}

								// Fast-forward: apply only newly received non-rollback actions in canonical order.
								if (unappliedNonRollback.length > 0) {
									yield* applyActionRecords(unappliedNonRollback)
								}
								yield* advanceAppliedRemoteServerIngestCursor()
								return remoteActions
							}
						if (hasPending && !hasRemote) {
							yield* Effect.logInfo("performSync.case2.sendPending", {
								pendingCount: pendingActions.length
							})
							yield* advanceAppliedRemoteServerIngestCursor()
							return yield* sendLocalActions()
						}
							if (hasPending && hasRemote) {
								const sortedPending = clockService.sortClocks(
									pendingActions.map((a) => ({
										action: a,
										clock: a.clock,
										clientId: a.client_id,
										id: a.id
									}))
								)
								const sortedRemote = clockService.sortClocks(
									remoteActions.map((a) => ({ action: a, clock: a.clock, clientId: a.client_id, id: a.id }))
								)

								const latestPendingAction = sortedPending[sortedPending.length - 1]?.action
								const earliestRemoteAction = sortedRemote[0]?.action

								if (latestPendingAction && earliestRemoteAction) {
									if (
										!remoteActions.find((a) => a._tag === "RollbackAction") &&
										clockService.compareClock(
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
										yield* sendLocalActions()
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
											return yield* sendLocalActions()
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
						Effect.catchAll((error) =>
							Effect.gen(function* () {
								const message = error instanceof Error ? error.message : String(error)
								yield* Effect.logError(`Sync failed: ${message}`, error)
								if (error instanceof SyncError) {
									return yield* Effect.fail(error)
								}
								return yield* Effect.fail(
									new SyncError({ message: `Sync failed: ${message}`, cause: error })
								)
							})
						),
						Effect.annotateLogs({ clientId, syncSessionId }),
						Effect.withSpan("SyncService.performSync", { attributes: { clientId, syncSessionId } })
					)
				)
			)

		const reconcile = (
			pendingActions: readonly ActionRecord[],
			remoteActions: readonly ActionRecord[], // Explicit return type
			allLocalActions: readonly ActionRecord[] // Receive all local actions
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
				) // Get Option<ActionRecord>
				const commonAncestor = Option.getOrNull(commonAncestorOpt) // Keep null for args if None
					yield* Effect.logDebug(
						`Rolled back to common ancestor during reconcile: ${JSON.stringify(commonAncestor)}`
					)
					const rollbackClock = yield* clockService.incrementClock // Get a new clock for the rollback action
					// even if the actual DB rollback happened in the SQL function's implicit transaction.
					const rollbackTransactionId = Date.now()
					const rollbackActionRecord = yield* actionRecordRepo.insert(
						ActionRecord.insert.make({
							id: crypto.randomUUID(),
							_tag: "RollbackAction", // Use the specific tag for rollback actions
						client_id: clientId, // The client performing the rollback
						clock: rollbackClock, // The new clock timestamp for this action
						args: {
							target_action_id: commonAncestor?.id ?? null,
							timestamp: rollbackClock.timestamp
						},
						synced: false, // This new action is initially unsynced
						created_at: new Date(),
						transaction_id: rollbackTransactionId // Associate with the current transaction context
					})
				)
				yield* Effect.logInfo(`Created RollbackAction record: ${rollbackActionRecord.id}`)

				const actionsToReplay = yield* actionRecordRepo.findUnappliedLocally() // Use new method
				yield* Effect.logDebug(
					`Final list of actions to REPLAY in reconcile: [${actionsToReplay.map((a: ActionRecord) => `${a.id} (${a._tag})`).join(", ")}]` // Added type for 'a'
				)
				// then check for any divergence, adding a SYNC action if needed
				yield* applyActionRecords(actionsToReplay)
				return yield* actionRecordRepo.allUnsynced()
			}).pipe(
				Effect.annotateLogs({ clientId, operation: "reconcile" }),
				Effect.withSpan("SyncService.reconcile", { attributes: { clientId } })
			)
		/**
		 * Applies incoming remote actions, creating a SYNC record to capture the resulting
		 * patches, and compares them against original patches to detect divergence.
		 */
		const applyActionRecords = (remoteActions: readonly ActionRecord[]) =>
			newTraceId.pipe(
				Effect.flatMap((applyBatchId) =>
					Effect.gen(function* () {
					yield* Effect.logInfo(
						`Applying ${remoteActions.length} remote actions and checking for divergence.`
					)
					yield* Effect.logDebug("applyActionRecords.remoteActions", {
						applyBatchId,
						count: remoteActions.length,
						actions: remoteActions.map((a) => ({
							id: a.id,
							_tag: a._tag,
							client_id: a.client_id,
							server_ingest_id: a.server_ingest_id
						}))
					})

					// 1. Use an application-level transaction identifier for the batch.
					const transactionId = Date.now()

				// 2. Create ONE placeholder SYNC ActionRecord for the batch
				const syncActionTag = "_InternalSyncApply"
				const syncActionArgs = {
					appliedActionIds: remoteActions.map((a) => a.id),
					timestamp: 0 // Add placeholder timestamp for internal action
				}
				const currentClock = yield* clockService.getClientClock // Use clock before potential increments
				const syncRecord = yield* actionRecordRepo.insert(
					ActionRecord.insert.make({
						id: crypto.randomUUID(),
						client_id: clientId,
						clock: currentClock, // Use current clock initially
						_tag: syncActionTag,
						args: syncActionArgs,
						created_at: new Date(),
						synced: false, // Placeholder is initially local
						transaction_id: transactionId
					})
				)
				yield* Effect.logDebug("applyActionRecords.createdSyncPlaceholder", {
					applyBatchId,
					syncActionRecordId: syncRecord.id,
					syncActionTag
				})
					yield* clientDbAdapter.setCaptureContext(syncRecord.id)

				// 3. Apply the incoming remote actions' logic (or patches for SYNC) in HLC order
				const sortedRemoteActions = clockService.sortClocks(
					remoteActions.map((a) => ({ ...a, clientId: a.client_id }))
				)

					const applyOneRemoteAction = (actionRecord: ActionRecord) =>
						Effect.gen(function* () {
						if (actionRecord._tag === "RollbackAction") {
							yield* Effect.logTrace(
								`Skipping RollbackAction during applyActionRecords (re-materialization is handled at the sync strategy level): ${actionRecord.id}`
							)
							yield* actionRecordRepo.markLocallyApplied(actionRecord.id)
							return // Move to the next action
						}

					const actionCreator = actionRegistry.getActionCreator(actionRecord._tag)

					if (actionRecord._tag === "_InternalSyncApply") {
						yield* Effect.logDebug("applyActionRecords.applyReceivedSyncPatches", {
							receivedSyncActionId: actionRecord.id
						})
						const syncAmrs = yield* actionModifiedRowRepo.findByActionRecordIds([actionRecord.id])
							if (syncAmrs.length > 0) {
								yield* clientDbAdapter.withPatchTrackingDisabled(
									applyForwardAmrs(syncAmrs).pipe(
										Effect.provideService(SqlClient.SqlClient, sqlClient)
									)
								)
								yield* Effect.logDebug(
									`Applied forward patches for ${syncAmrs.length} AMRs associated with received SYNC action ${actionRecord.id}`
								)
						} else {
							yield* Effect.logWarning(
								`Received SYNC action ${actionRecord.id} had no associated ActionModifiedRows.`
							)
						}
					} else if (!actionCreator) {
						return yield* Effect.fail(
							new SyncError({ message: `Missing action creator: ${actionRecord._tag}` })
						)
					} else {
						yield* Effect.logDebug("applyActionRecords.applyRemoteAction", {
							remoteActionId: actionRecord.id,
							remoteActionTag: actionRecord._tag,
							args: actionRecord.args
						})

						yield* deterministicId.withActionContext(
							actionRecord.id,
							actionCreator(actionRecord.args).execute()
						)
					}
					yield* actionRecordRepo.markLocallyApplied(actionRecord.id) // Use new method
					yield* Effect.logDebug(`Marked remote action ${actionRecord.id} as applied locally.`)
					}).pipe(
						Effect.annotateLogs({
							remoteActionId: actionRecord.id,
							remoteActionTag: actionRecord._tag
						}),
						Effect.withSpan("SyncService.applyActionRecords.applyOneRemoteAction", {
							attributes: { remoteActionId: actionRecord.id, remoteActionTag: actionRecord._tag }
						})
					)

					for (const actionRecord of sortedRemoteActions) {
						yield* applyOneRemoteAction(actionRecord)
					}
						yield* Effect.logDebug(
							`Finished applying ${remoteActions.length} remote actions logic/patches.`
						)
					// Merge observed remote clocks into the client's current clock so subsequent
					// local actions carry causal context (vector) and don't regress vs. far-future remotes.
					yield* clockService.observeRemoteClocks(sortedRemoteActions.map((a) => a.clock))

						// 4. Fetch *all* generated patches associated with the placeholder SYNC ActionRecord
						const generatedPatches = yield* actionModifiedRowRepo.findByActionRecordIds([syncRecord.id])

				// 5. Fetch *all* original patches associated with *all* received actions
				const originalRemoteActionIds = sortedRemoteActions
					.filter((a) => a._tag !== "_InternalSyncApply" && a._tag !== "RollbackAction")
					.map((a) => a.id)
				const originalPatches =
					yield* actionModifiedRowRepo.findByActionRecordIds(originalRemoteActionIds)
				const knownRemoteActionIds = sortedRemoteActions
					.filter((a) => a._tag !== "RollbackAction")
					.map((a) => a.id)
				const knownPatches = yield* actionModifiedRowRepo.findByActionRecordIds(knownRemoteActionIds)
				yield* Effect.logDebug(`Comparing generated vs original patches for divergence check.`)
				yield* Effect.logDebug(
					`Generated Patches (${generatedPatches.length}): ${JSON.stringify(generatedPatches, null, 2)}`
				)
				yield* Effect.logDebug(
					`Original Patches (${originalPatches.length}): ${JSON.stringify(originalPatches, null, 2)}`
				)
				yield* Effect.logDebug(
					`Known Patches (Base + SYNC) (${knownPatches.length}): ${JSON.stringify(knownPatches, null, 2)}`
				)

				// 6. Compare total generated patches vs. total original patches
				const arePatchesIdentical = compareActionModifiedRows(generatedPatches, originalPatches) // Use strict comparison

				type FinalRowEffect = {
					operation: ActionModifiedRow["operation"]
					columns: Record<string, unknown>
				}

				const toFinalRowEffects = (rows: readonly ActionModifiedRow[]) => {
					const effectsByKey = new Map<string, FinalRowEffect>()
					for (const row of rows) {
						const key = `${row.table_name}|${row.row_id}`
						const existing = effectsByKey.get(key) ?? { operation: row.operation, columns: {} }
						existing.operation = row.operation

						// If the row is deleted, only the delete matters for forward convergence.
						if (row.operation === "DELETE") {
							existing.columns = {}
							effectsByKey.set(key, existing)
							continue
						}

						for (const [columnKey, columnValue] of Object.entries(row.forward_patches)) {
							existing.columns[columnKey] = columnValue
						}
						effectsByKey.set(key, existing)
					}
					return effectsByKey
				}

				const isRowEffectCoveredByKnown = (
					replay: FinalRowEffect,
					known: FinalRowEffect | undefined
				): boolean => {
					if (replay.operation === "DELETE") {
						return known?.operation === "DELETE"
					}
					if (!known) return false
					if (known.operation === "DELETE") return false

					for (const [columnKey, replayValue] of Object.entries(replay.columns)) {
						if (!Object.prototype.hasOwnProperty.call(known.columns, columnKey)) return false
						if (!deepObjectEquals(replayValue, known.columns[columnKey])) return false
					}

					return true
				}

				const generatedFinalEffects = toFinalRowEffects(generatedPatches)
				const knownFinalEffects = toFinalRowEffects(knownPatches)

				const deltaRowKeys: Array<{ table_name: string; row_id: string }> = []
				const coveredRowKeys: Array<{ table_name: string; row_id: string }> = []
				for (const [key, generatedEffect] of generatedFinalEffects) {
					const [table_name, row_id] = key.split("|")
					if (!table_name || !row_id) continue

					if (isRowEffectCoveredByKnown(generatedEffect, knownFinalEffects.get(key))) {
						coveredRowKeys.push({ table_name, row_id })
					} else {
						deltaRowKeys.push({ table_name, row_id })
					}
				}

				const hasSyncDelta = deltaRowKeys.length > 0

				yield* Effect.logDebug(
					`Overall Divergence check (strict): Generated ${generatedPatches.length} patches, Original ${originalPatches.length} patches. Identical: ${arePatchesIdentical}`
				)
				yield* Effect.logDebug(
					`SYNC delta check (generated - known): delta rows=${deltaRowKeys.length}, covered rows=${coveredRowKeys.length}`
				)

					if (hasSyncDelta) {
						const deltaDetails = deltaRowKeys.map(({ table_name, row_id }) => {
							const key = `${table_name}|${row_id}`
							const generated = generatedFinalEffects.get(key)
							const known = knownFinalEffects.get(key)

							const missingColumns: string[] = []
							const differingColumns: string[] = []
							const missingColumnDetails: Array<{
								column: string
								generatedKind: string
								generatedPreview: string
							}> = []
							const differingColumnDetails: Array<{
								column: string
								generatedKind: string
								generatedPreview: string
								knownKind: string
								knownPreview: string
							}> = []

							if (generated?.operation === "DELETE") {
								if (known?.operation !== "DELETE") {
									differingColumns.push("_operation")
									differingColumnDetails.push({
										column: "_operation",
										generatedKind: "string",
										generatedPreview: valuePreview(generated.operation),
										knownKind: "string",
										knownPreview: valuePreview(known?.operation ?? "UNKNOWN")
									})
								}
							} else {
								for (const [columnKey, replayValue] of Object.entries(generated?.columns ?? {})) {
									if (!known || !Object.prototype.hasOwnProperty.call(known.columns, columnKey)) {
										missingColumns.push(columnKey)
										missingColumnDetails.push({
											column: columnKey,
											generatedKind: valueKind(replayValue),
											generatedPreview: valuePreview(replayValue)
										})
										continue
									}
									if (!deepObjectEquals(replayValue, known.columns[columnKey])) {
										differingColumns.push(columnKey)
										differingColumnDetails.push({
											column: columnKey,
											generatedKind: valueKind(replayValue),
											generatedPreview: valuePreview(replayValue),
											knownKind: valueKind(known.columns[columnKey]),
											knownPreview: valuePreview(known.columns[columnKey])
										})
									}
								}
							}

							return {
								table_name,
								row_id,
								generatedOperation: generated?.operation ?? "UNKNOWN",
								knownOperation: known?.operation ?? "UNKNOWN",
								missingColumns,
								differingColumns,
								missingColumnDetails,
								differingColumnDetails
							}
						})

					yield* Effect.logWarning("applyActionRecords.syncDeltaDetected", {
						applyBatchId,
						syncActionRecordId: syncRecord.id,
						deltaRowCount: deltaRowKeys.length,
						coveredRowCount: coveredRowKeys.length,
						deltaDetails
					})
				}

				if (!hasSyncDelta) {
					yield* Effect.logInfo(
						"No outgoing SYNC delta remains after accounting for received patches (base + SYNC). Deleting placeholder SYNC action."
					)
					yield* actionModifiedRowRepo.deleteByActionRecordIds(syncRecord.id)
					yield* actionRecordRepo.deleteById(syncRecord.id)
				} else {
					// 7b. Divergence detected and there is remaining delta to sync:
					yield* Effect.logWarning("Overall divergence detected Keeping placeholder SYNC action.")
					// Prune any generated patches that are already covered by received patches (base + SYNC).
					for (const { table_name, row_id } of coveredRowKeys) {
						yield* sqlClient`
							DELETE FROM action_modified_rows
							WHERE action_record_id = ${syncRecord.id}
							AND table_name = ${table_name}
							AND row_id = ${row_id}
						`
					}
					const newSyncClock = yield* clockService.incrementClock
					yield* Effect.logDebug(
						`Updating placeholder SYNC action ${syncRecord.id} clock due to divergence: ${JSON.stringify(newSyncClock)}`
					)
					yield* sqlClient`UPDATE action_records SET clock = ${JSON.stringify(newSyncClock)} WHERE id = ${syncRecord.id}`
					// The delta patches are already applied locally (they came from replay). Track this so rollbacks are correct.
					yield* actionRecordRepo.markLocallyApplied(syncRecord.id)
				}

				yield* clockService.updateLastSyncedClock()

				return remoteActions // Return original remote actions
				}).pipe(
					sqlClient.withTransaction,
					Effect.ensuring(clientDbAdapter.setCaptureContext(null).pipe(Effect.orDie)),
					Effect.annotateLogs({ clientId, applyBatchId, operation: "applyActionRecords" }),
					Effect.withSpan("SyncService.applyActionRecords", {
						attributes: { clientId, applyBatchId, remoteActionCount: remoteActions.length }
					})
				)
				)
			)

		/**
		 * Finds the most recent common ancestor action based on local pending actions (synced=false)
		 * and unapplied remote actions (synced=true, applied=false).
		 * @returns An Effect resolving to an Option containing the common ancestor ActionRecord, or None if not found.
		 */
		const findCommonAncestor = (): Effect.Effect<
			Option.Option<ActionRecord>,
			SqlError.SqlError | ParseResult.ParseError
		> =>
			Effect.gen(function* () {
				const compareActionRecords = (a: ActionRecord, b: ActionRecord) =>
					clockService.compareClock(
						{ clock: a.clock, clientId: a.client_id, id: a.id },
						{ clock: b.clock, clientId: b.client_id, id: b.id }
					)

					const [allActions, appliedIdsRows, pendingActions] = yield* Effect.all([
						actionRecordRepo.all(),
						sqlClient<{ action_record_id: string }>`SELECT action_record_id FROM local_applied_action_ids`,
						actionRecordRepo.findBySynced(false)
					])

				const appliedIds = new Set(appliedIdsRows.map((r) => r.action_record_id))
				const remoteUnapplied = allActions.filter((a) => a.synced === true && !appliedIds.has(a.id))
				const nonAncestor = [...pendingActions, ...remoteUnapplied]

				const appliedAndSynced = allActions.filter((a) => a.synced === true && appliedIds.has(a.id))
				if (nonAncestor.length === 0) {
					const latest = [...appliedAndSynced].sort(compareActionRecords).at(-1)
					return latest ? Option.some(latest) : Option.none()
				}

				const earliestNonAncestor = [...nonAncestor].sort(compareActionRecords)[0]
				if (!earliestNonAncestor) return Option.none()

				const latestBefore = [...appliedAndSynced]
					.filter((a) => compareActionRecords(a, earliestNonAncestor) < 0)
					.sort(compareActionRecords)
					.at(-1)

				return latestBefore ? Option.some(latestBefore) : Option.none()
			}).pipe(Effect.withSpan("db.findCommonAncestor"))

		/**
		 * Clean up old, synced action records to prevent unbounded growth.
		 * We retain records for up to one week by default
		 */
			const cleanupOldActionRecords = (retentionDays = 7) =>
					Effect.gen(function* () {
						const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000
						yield* sqlClient`
							DELETE FROM action_records
							WHERE synced = 1
							AND clock_time_ms < ${cutoffMs}
						`
					yield* Effect.logInfo(`Cleaned up action records older than ${retentionDays} days`)
					return true
				}).pipe(Effect.annotateLogs("clientId", clientId))

		/**
		 * Attempt to send all unsynced actions to the server.
		 */
		const sendLocalActions = () =>
			newTraceId.pipe(
					Effect.flatMap((sendBatchId) =>
						Effect.gen(function* () {
								const actionsToSendRaw = yield* actionRecordRepo.allUnsynced()
								const amrs = yield* actionModifiedRowRepo.allUnsynced()
								if (actionsToSendRaw.length === 0) {
									yield* Effect.logDebug("sendLocalActions.noop", { sendBatchId })
									return []
									}

								const actionsToSend = actionsToSendRaw
								const basisServerIngestId = yield* clockService.getLastSeenServerIngestId

									const actionTags = actionsToSend.reduce<Record<string, number>>((acc, action) => {
										acc[action._tag] = (acc[action._tag] ?? 0) + 1
										return acc
									}, {})
							const amrCountsByActionRecordId: Record<string, number> = {}
							for (const amr of amrs) {
								amrCountsByActionRecordId[amr.action_record_id] =
									(amrCountsByActionRecordId[amr.action_record_id] ?? 0) + 1
							}

								yield* Effect.logInfo("sendLocalActions.sending", {
									sendBatchId,
									basisServerIngestId,
									actionCount: actionsToSend.length,
									amrCount: amrs.length,
									actionTags,
									hasSyncDelta: actionsToSend.some((a) => a._tag === "_InternalSyncApply"),
									actions: actionsToSend.map((a) => ({
									id: a.id,
									_tag: a._tag,
									client_id: a.client_id,
									clock: a.clock
								})),
										amrCountsByActionRecordId
									})

							const syncActionIds = actionsToSend
								.filter((a) => a._tag === "_InternalSyncApply")
								.map((a) => a.id)
							if (syncActionIds.length > 0) {
								const syncActionIdSet = new Set(syncActionIds)
								const syncAmrPreview = amrs
									.filter((amr) => syncActionIdSet.has(amr.action_record_id))
									.slice(0, 10)
									.map((amr) => ({
										id: amr.id,
										table_name: amr.table_name,
										row_id: amr.row_id,
										operation: amr.operation,
										forward_patches: valuePreview(amr.forward_patches),
										reverse_patches: valuePreview(amr.reverse_patches)
									}))
								yield* Effect.logDebug("sendLocalActions.syncDelta.preview", {
									sendBatchId,
									syncActionIds,
									syncAmrPreview
								})
							}

								yield* syncNetworkService
									.sendLocalActions(actionsToSend, amrs, basisServerIngestId)
									.pipe(
									Effect.withSpan("SyncNetworkService.sendLocalActions", {
										attributes: {
											clientId,
										sendBatchId,
										actionCount: actionsToSend.length,
										amrCount: amrs.length
									}
									}),
								Effect.catchAll((error) =>
									Effect.gen(function* () {
										const errorMessage = error instanceof Error ? error.message : String(error)
										yield* Effect.logError("sendLocalActions.sendFailed", {
											sendBatchId,
											actionCount: actionsToSend.length,
											amrCount: amrs.length,
											actionTags,
											errorMessage,
											error
										})
										if (error instanceof NetworkRequestError) {
											yield* Effect.logWarning("sendLocalActions.networkError", {
												sendBatchId,
												message: error.message,
												cause: error.cause ?? null
											})
										}
										return yield* Effect.fail(
											new SyncError({
												message: `Failed to send actions to server: ${errorMessage}`,
												cause: error
											})
										)
									})
							)
							)
							for (const action of actionsToSend) {
								yield* actionRecordRepo.markAsSynced(action.id)
								yield* Effect.logDebug("sendLocalActions.markedSynced", {
									sendBatchId,
									actionId: action.id,
									actionTag: action._tag
								})
							}
						yield* clockService.updateLastSyncedClock()

						return actionsToSend // Return the actions that were handled
					}).pipe(
						Effect.catchAll((error) => {
							const message = error instanceof Error ? error.message : String(error)
							return Effect.fail(
								new SyncError({
									message: `Failed during sendLocalActions: ${message}`,
									cause: error
								})
							)
						}),
						Effect.annotateLogs({ clientId, sendBatchId, operation: "sendLocalActions" }),
						Effect.withSpan("SyncService.sendLocalActions", {
							attributes: { clientId, sendBatchId }
						})
					)
				)
			)

		return {
			executeAction,
			performSync,
			cleanupOldActionRecords,
			applyActionRecords
		}
	}),
	dependencies: [
		ActionRecordRepo.Default,
		ActionModifiedRowRepo.Default, // Add ActionModifiedRowRepo dependency
		ActionRegistry.Default, // Added ActionRegistry
		DeterministicId.Default
	]
}) {}
