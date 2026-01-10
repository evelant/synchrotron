import { type SqlError } from "@effect/sql" // Import SqlClient service
import { PgLiteClient } from "@effect/sql-pglite"
import { ActionRegistry } from "@synchrotron/sync-core/ActionRegistry"
import * as HLC from "@synchrotron/sync-core/HLC" // Import HLC namespace
import { Array, Effect, Option, Schema } from "effect" // Import ReadonlyArray
import { ActionModifiedRowRepo, compareActionModifiedRows } from "./ActionModifiedRowRepo"
import { ActionRecordRepo } from "./ActionRecordRepo"
import { ClockService } from "./ClockService"
import { Action, ActionRecord } from "./models" // Import ActionModifiedRow type from models
import { NetworkRequestError, SyncNetworkService } from "./SyncNetworkService"
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
		const sql = yield* PgLiteClient.PgLiteClient // Get the generic SqlClient service
		const clockService = yield* ClockService
		const actionRecordRepo = yield* ActionRecordRepo
		const actionModifiedRowRepo = yield* ActionModifiedRowRepo
		const syncNetworkService = yield* SyncNetworkService
		const clientId = yield* clockService.getNodeId
		const actionRegistry = yield* ActionRegistry
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
				yield* Effect.logInfo(`Executing action: ${action._tag}"}`)
				// 1. Get current transaction ID
				const txidResult = yield* sql<{ txid: number }>`SELECT txid_current() as txid`
				const transactionId = txidResult[0]?.txid
				if (!transactionId) {
					return yield* Effect.fail(
						new ActionExecutionError({
							actionId: action._tag,
							cause: new Error("Failed to get transaction ID")
						})
					)
				}
				const executionTimestamp = new Date()

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

				// Set context for deterministic ID trigger before executing action
				yield* sql`SELECT set_config('sync.current_action_record_id', ${actionRecord.id}, true), set_config('sync.collision_map', '{}', true)`
				// 6. Apply the action - this will trigger database changes
				// The trigger will use the context set above.
				// and will throw an exception if the action fails
				// all changes, including the action record inserted above
				const result = yield* action.execute() // Pass args with timestamp to apply

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
				sql.withTransaction, // Restore transaction wrapper
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
				Effect.annotateLogs("clientId", clientId) // Use service-level clientId here
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
				yield* sql`SELECT rollback_to_action(${commonAncestor?.id ?? null})`
				return commonAncestor
			}).pipe(Effect.annotateLogs("clientId", clientId))

		/**
		 * synchronize with the server
		 * Fetches pending local actions and unseen remote actions, then determines the appropriate sync strategy:
		 * - Case 1: No local pending, apply remote actions.
		 * - Case 2: No remote actions, send local pending actions.
		 * - Case 3: Both local and remote actions exist, perform reconciliation.
		 * Returns the actions that were effectively processed (applied, sent, or reconciled).
		 */
		const performSync = () =>
			Effect.gen(function* () {
				// 1. Get pending local actions
				const pendingActions = yield* actionRecordRepo.findBySynced(false)
				yield* Effect.logDebug(
					`performSync start: Found ${pendingActions.length} pending actions: [${pendingActions.map((a) => `${a.id} (${a._tag})`).join(", ")}]`
				)

				// 2. Get remote actions since last sync
				const { actions: remoteActions } = yield* syncNetworkService.fetchRemoteActions()
				yield* Effect.logInfo(
					`Fetched ${remoteActions.length} remote actions for client ${clientId}: [${remoteActions.map((a) => `${a.id} (${a._tag})`).join(", ")}]`
				)
				const latestSeenServerIngestId = remoteActions.reduce((max, action) => {
					const ingestId = action.server_ingest_id
					if (ingestId === null || ingestId === undefined) return max
					return ingestId > max ? ingestId : max
				}, 0)

				const hasPending = pendingActions.length > 0
				const hasRemote = remoteActions.length > 0
				if (!hasPending && !hasRemote) {
					yield* Effect.logInfo("No pending or remote actions to sync.")
					return [] as const // Return readonly empty array
				}
				if (!hasPending && hasRemote) {
					yield* Effect.logInfo(
						`Case 1: No pending actions, applying ${remoteActions.length} remote actions and checking divergence.`
					)
					// applyActionRecords handles clock updates for received actions
					const applied = yield* applyActionRecords(remoteActions)
					yield* clockService.advanceLastSeenServerIngestId(latestSeenServerIngestId)
					return applied
				}
				if (hasPending && !hasRemote) {
					yield* Effect.logInfo(
						`Case 2: No remote actions, sending ${pendingActions.length} local actions.`
					)
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
								yield* Effect.logInfo(
									`Case 4: Latest pending action (${latestPendingAction.id}) is older than earliest remote action (${earliestRemoteAction.id}). Applying remote, then sending pending.`
								)

							// 1. Apply remote actions
							const appliedRemotes = yield* applyActionRecords(remoteActions)
							yield* clockService.advanceLastSeenServerIngestId(latestSeenServerIngestId)
							// 2. Send pending actions
							yield* sendLocalActions()
							// For now, returning applied remotes as they were processed first in this flow.
							return appliedRemotes
						} else {
							yield* Effect.logInfo(
								"Case 3: Actions interleaved or remote older than pending. Reconciliation required."
							)
							const allLocalActions = yield* actionRecordRepo.all()
								yield* reconcile(pendingActions, remoteActions, allLocalActions)
								yield* clockService.advanceLastSeenServerIngestId(latestSeenServerIngestId)
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
				Effect.annotateLogs("clientId", clientId)
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
				const rollbackTxIdResult = yield* sql<{ txid: number }>`SELECT txid_current() as txid`
				const rollbackTransactionId = rollbackTxIdResult[0]?.txid

				if (!rollbackTransactionId) {
					return yield* Effect.fail(
						new SyncError({
							message: "Failed to get transaction ID for RollbackAction during reconcile"
						})
					)
				}
				const rollbackActionRecord = yield* actionRecordRepo.insert(
					ActionRecord.insert.make({
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
			})

			const findRollbackTarget = (incomingActions: readonly ActionRecord[]) =>
				Effect.gen(function* () {
					const rollbacks = incomingActions.filter((a) => a._tag === "RollbackAction")
					// find oldest target of all rollback in the incoming actions
					// findByIds sorts by canonical replay order so we can take array head
					const oldestRollbackTarget = Array.head(
						yield* actionRecordRepo.findByIds(rollbacks.map((a: any) => a.args.target_action_id))
					)

					const pendingActions = yield* actionRecordRepo.findBySynced(false)

					const currentRollbackTarget = yield* findCommonAncestor()
					let rollbackTarget = Option.none<ActionRecord>()
					if (
						pendingActions.length > 0 &&
						incomingActions.length > 0 &&
						Option.isSome(oldestRollbackTarget) &&
						Option.isSome(currentRollbackTarget) &&
						clockService.compareClock(
							{
								clock: oldestRollbackTarget.value.clock,
								clientId: oldestRollbackTarget.value.client_id,
								id: oldestRollbackTarget.value.id
							},
							{
								clock: currentRollbackTarget.value.clock,
								clientId: currentRollbackTarget.value.client_id,
								id: currentRollbackTarget.value.id
							}
						) < 0
					) {
						rollbackTarget = oldestRollbackTarget
					} else {
						rollbackTarget = currentRollbackTarget
					}

				return rollbackTarget
			})
		/**
		 * Applies incoming remote actions, creating a SYNC record to capture the resulting
		 * patches, and compares them against original patches to detect divergence.
		 */
		const applyActionRecords = (remoteActions: readonly ActionRecord[]) =>
			Effect.gen(function* () {
				yield* Effect.logInfo(
					`Applying ${remoteActions.length} remote actions and checking for divergence.`
				)

				// 1. Get Transaction ID for the *entire* batch application
				const txidResult = yield* sql<{ txid: number }>`SELECT txid_current() as txid`
				const transactionId = txidResult.length > 0 ? txidResult[0]!.txid : undefined
				if (!transactionId) {
					return yield* Effect.dieMessage("Failed to get transaction ID for applyActionRecords")
				}

				// 2. Create ONE placeholder SYNC ActionRecord for the batch
				const syncActionTag = "_InternalSyncApply"
				const syncActionArgs = {
					appliedActionIds: remoteActions.map((a) => a.id),
					timestamp: 0 // Add placeholder timestamp for internal action
				}
				const currentClock = yield* clockService.getClientClock // Use clock before potential increments
				const syncRecord = yield* actionRecordRepo.insert(
					ActionRecord.insert.make({
						client_id: clientId,
						clock: currentClock, // Use current clock initially
						_tag: syncActionTag,
						args: syncActionArgs,
						created_at: new Date(),
						synced: false, // Placeholder is initially local
						transaction_id: transactionId
					})
				)
				yield* Effect.logDebug(`Created placeholder SYNC action: ${syncRecord.id}`)

				// 3. Apply the incoming remote actions' logic (or patches for SYNC) in HLC order
				const appliedRemoteClocks: HLC.HLC[] = []
				const sortedRemoteActions = clockService.sortClocks(
					remoteActions.map((a) => ({ ...a, clientId: a.client_id }))
				)

				for (const actionRecord of sortedRemoteActions) {
					// Set context for deterministic ID trigger before applying this specific action
					yield* sql`SELECT set_config('sync.current_action_record_id', ${actionRecord.id}, true), set_config('sync.collision_map', '{}', true)`

					if (actionRecord._tag === "_Rollback") {
						yield* Effect.logTrace(
							`Skipping application of Rollback action during apply phase: ${actionRecord.id}`
						)
						yield* actionRecordRepo.markLocallyApplied(actionRecord.id) // Use new method
						appliedRemoteClocks.push(actionRecord.clock) // Still update clock based on its timestamp
						continue // Move to the next action
					}

					const actionCreator = actionRegistry.getActionCreator(actionRecord._tag)

					if (actionRecord._tag === "_InternalSyncApply") {
						yield* Effect.logDebug(`Applying patches for received SYNC action: ${actionRecord.id}`)
						const syncAmrs = yield* actionModifiedRowRepo.findByActionRecordIds([actionRecord.id])
						if (syncAmrs.length > 0) {
							const amrIds = syncAmrs.map((amr) => amr.id)
							yield* sql`SELECT apply_forward_amr_batch(${sql.array(amrIds)})`
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
						yield* Effect.logDebug(
							`Applying logic for remote action: ${actionRecord.id} (${actionRecord._tag}) ${JSON.stringify(actionRecord.args)}`
						)

						yield* actionCreator(actionRecord.args).execute()
					}
					yield* actionRecordRepo.markLocallyApplied(actionRecord.id) // Use new method
					yield* Effect.logDebug(`Marked remote action ${actionRecord.id} as applied locally.`)
					appliedRemoteClocks.push(actionRecord.clock)
				}
				yield* Effect.logDebug(
					`Finished applying ${remoteActions.length} remote actions logic/patches.`
				)

				// 4. Fetch *all* generated patches associated with this batch transaction
				const generatedPatches = yield* actionModifiedRowRepo.findByTransactionId(transactionId)

				// 5. Fetch *all* original patches associated with *all* received actions
				const originalRemoteActionIds = sortedRemoteActions.map((a) => a.id)
				const originalPatches =
					yield* actionModifiedRowRepo.findByActionRecordIds(originalRemoteActionIds)
				yield* Effect.logDebug(`Comparing generated vs original patches for divergence check.`)
				yield* Effect.logDebug(
					`Generated Patches (${generatedPatches.length}): ${JSON.stringify(generatedPatches, null, 2)}`
				)
				yield* Effect.logDebug(
					`Original Patches (${originalPatches.length}): ${JSON.stringify(originalPatches, null, 2)}`
				)

				// 6. Compare total generated patches vs. total original patches
				const arePatchesIdentical = compareActionModifiedRows(generatedPatches, originalPatches) // Use strict comparison

				yield* Effect.logDebug(
					`Overall Divergence check: Generated ${generatedPatches.length} patches, Original ${originalPatches.length} patches. Identical: ${arePatchesIdentical}`
				)

				if (arePatchesIdentical) {
					yield* Effect.logInfo("No overall divergence detected. Deleting placeholder SYNC action.")
					yield* actionRecordRepo.deleteById(syncRecord.id)
				} else {
					// 7b. Divergence detected AND no corrective SYNC action was received:
					yield* Effect.logWarning("Overall divergence detected Keeping placeholder SYNC action.")
					const newSyncClock = yield* clockService.incrementClock
					yield* Effect.logDebug(
						`Updating placeholder SYNC action ${syncRecord.id} clock due to divergence: ${JSON.stringify(newSyncClock)}`
					)
					yield* sql`UPDATE action_records SET clock = ${JSON.stringify(newSyncClock)} WHERE id = ${syncRecord.id}`
				}

				yield* clockService.updateLastSyncedClock()

				return remoteActions // Return original remote actions
			}).pipe(sql.withTransaction, Effect.annotateLogs("clientId", clientId))

		/**
		 * Finds the most recent common ancestor action based on local pending actions (synced=false)
		 * and unapplied remote actions (synced=true, applied=false).
		 * @returns An Effect resolving to an Option containing the common ancestor ActionRecord, or None if not found.
		 */
		const findCommonAncestor = (): Effect.Effect<Option.Option<ActionRecord>, SqlError.SqlError> =>
			Effect.gen(function* () {
				const result = yield* sql<ActionRecord>`SELECT * FROM find_common_ancestor()`
				return Array.head(result)
			}).pipe(Effect.withSpan("db.findCommonAncestor"))

		/**
		 * Clean up old, synced action records to prevent unbounded growth.
		 * We retain records for up to one week by default
		 */
		const cleanupOldActionRecords = (retentionDays = 7) =>
			Effect.gen(function* () {
				yield* sql`
					DELETE FROM action_records
					WHERE synced = true
					AND created_at < (NOW() - INTERVAL '1 day' * ${retentionDays})
				`
				yield* Effect.logInfo(`Cleaned up action records older than ${retentionDays} days`)
				return true
			}).pipe(Effect.annotateLogs("clientId", clientId))

		/**
		 * Attempt to send all unsynced actions to the server.
		 */
		const sendLocalActions = () =>
			Effect.gen(function* () {
				const actionsToSend = yield* actionRecordRepo.allUnsynced()
				const amrs = yield* actionModifiedRowRepo.allUnsynced()
				if (actionsToSend.length === 0) {
					return []
				}

				yield* Effect.logInfo(`Sending ${actionsToSend.length} actions to server`)

				yield* syncNetworkService.sendLocalActions(actionsToSend, amrs).pipe(
					Effect.catchAll((error) =>
						Effect.gen(function* () {
							if (error instanceof NetworkRequestError) {
								yield* Effect.logWarning(`Failed to send actions to server: ${error.message}`)
							}
							return yield* Effect.fail(
								new SyncError({
									message: `Failed to send actions to server: ${error.message}`,
									cause: error
								})
							)
						})
					)
				)
				for (const action of actionsToSend) {
					yield* actionRecordRepo.markAsSynced(action.id)
					yield* Effect.logDebug(
						`Marked action ${action.id} (${action._tag}) as synced after send.`
					)
				}
				yield* clockService.updateLastSyncedClock()

				return actionsToSend // Return the actions that were handled
			}).pipe(
				Effect.catchAll((error) => {
					const message = error instanceof Error ? error.message : String(error)
					return Effect.fail(
						new SyncError({ message: `Failed during sendLocalActions: ${message}`, cause: error })
					)
				}),
				Effect.annotateLogs("clientId", clientId)
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
		ActionRegistry.Default // Added ActionRegistry
	]
}) {}
