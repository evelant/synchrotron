import { PgLiteClient } from "@effect/sql-pglite"
import { ActionRegistry } from "@synchrotron/sync-core/ActionRegistry"
import * as HLC from "@synchrotron/sync-core/HLC" // Import HLC namespace
import { Effect, Option, Schema, type Fiber, Array } from "effect" // Import ReadonlyArray
import { ActionModifiedRowRepo, compareActionModifiedRows } from "./ActionModifiedRowRepo"
import { ActionRecordRepo } from "./ActionRecordRepo"
import { ClockService } from "./ClockService"
import { Action, ActionRecord, type ActionModifiedRow } from "./models" // Import ActionModifiedRow type from models
import { SqlClient, type SqlError } from "@effect/sql" // Import SqlClient service
import { NetworkRequestError, SyncNetworkService } from "./SyncNetworkService"
import { deepObjectEquals } from "@synchrotron/sync-core/utils"

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

// Create the service tag
export class SyncService extends Effect.Service<SyncService>()("SyncService", {
	effect: Effect.gen(function* () {
		// Get required services
		const sql = yield* PgLiteClient.PgLiteClient
		const sqlClientService = yield* SqlClient.SqlClient // Get the SqlClient service
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
		const executeAction = <A extends Record<string, unknown>, EE, R>(action: Action<A, EE, R>) =>
			// First wrap everything in a transaction
			Effect.gen(function* () {
				yield* Effect.logInfo(`Executing action: ${action._tag}"}`)
				// 1. Get current transaction ID
				const txidResult = yield* sql<{ txid: number }>`SELECT txid_current() as txid`
				// Ensure txResult is not empty and txid exists before converting
				const transactionId = txidResult[0]?.txid

				// console.log("transaction id is ", transactionId) // Keep console for now if helpful
				if (!transactionId) {
					return yield* Effect.fail(
						new ActionExecutionError({
							actionId: action._tag,
							cause: new Error("Failed to get transaction ID")
						})
					)
				}

				// Capture execution time *before* clock increment for determinism
				const executionTimestamp = new Date() // Use standard Date for simplicity, could use HLC timestamp if needed across system

				// 2. Increment the client's clock
				const newClock = yield* clockService.incrementClock

				// 3. Get client ID
				const localClientId = yield* clockService.getNodeId // Use local variable to avoid shadowing

				// 4. Create an action record (with empty reverse patches initially)
				// Inject the execution timestamp *only* if it's not already present (i.e., not a replay)
				const timestampToUse =
					typeof action.args.timestamp === "number"
						? action.args.timestamp
						: executionTimestamp.getTime()

				const argsWithTimestamp: A & { timestamp: number } = {
					...action.args,
					timestamp: timestampToUse
				}
				// 5. Store the action record
				const actionRecord = yield* actionRecordRepo.insert(
					ActionRecord.insert.make({
						client_id: localClientId,
						clock: newClock,
						_tag: action._tag,
						args: argsWithTimestamp, // Store args with timestamp
						synced: false,
						// Explicitly cast to BigInt to ensure schema validation passes
						transaction_id: transactionId
					})
				)

				// 6. Apply the action - this will trigger database changes
				// and will throw an exception if the action fails
				// If this fails, sql.withTransaction will automatically roll back
				// all changes, including the action record inserted above
				yield* action.execute() // Pass args with timestamp to apply

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

				// Mark the action as locally applied *within the same transaction*
				yield* actionRecordRepo.markLocallyApplied(updatedRecord.value.id)

				return updatedRecord.value
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
				// Find common ancestor using the corrected logic and all local actions
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

				// --- Branching Logic ---

				const hasPending = pendingActions.length > 0
				const hasRemote = remoteActions.length > 0

				// Case 0: No actions anywhere
				if (!hasPending && !hasRemote) {
					yield* Effect.logInfo("No pending or remote actions to sync.")
					return [] as const // Return readonly empty array
				}

				// Case 1: No pending actions -> Apply remote + Check Divergence
				if (!hasPending && hasRemote) {
					yield* Effect.logInfo(
						`Case 1: No pending actions, applying ${remoteActions.length} remote actions and checking divergence.`
					)
					// applyActionRecords handles clock updates for received actions
					return yield* applyActionRecords(remoteActions)
				}

				// Case 2: No remote actions -> Send pending
				if (hasPending && !hasRemote) {
					yield* Effect.logInfo(
						`Case 2: No remote actions, sending ${pendingActions.length} local actions.`
					)
					return yield* sendLocalActions()
				}

				// Case 3: Both pending and remote actions exist -> Reconcile
				if (hasPending && hasRemote) {
					// --- Differentiate between Case 3 and Case 4 based on HLC ---
					const latestPendingClockOpt = clockService.getLatestClock(pendingActions)
					const earliestRemoteClockOpt = clockService.getEarliestClock(remoteActions)

					if (Option.isSome(latestPendingClockOpt) && Option.isSome(earliestRemoteClockOpt)) {
						const latestPendingClock = latestPendingClockOpt.value
						const earliestRemoteClock = earliestRemoteClockOpt.value

						// Compare clocks We need the actual ActionRecord to get the clientId for compareClock
						const latestPendingAction = pendingActions.find((a) =>
							HLC.equals(a.clock, latestPendingClock)
						)
						const earliestRemoteAction = remoteActions.find((a) =>
							HLC.equals(a.clock, earliestRemoteClock)
						)

						if (
							//if no incoming rollback actions and all remote actions happened AFTER all local pending actions.
							!remoteActions.find((a) => a._tag === "RollbackAction") &&
							latestPendingAction &&
							earliestRemoteAction &&
							clockService.compareClock(
								{ clock: latestPendingAction.clock, clientId },
								{ clock: earliestRemoteAction.clock, clientId: earliestRemoteAction.client_id }
							) < 0
						) {
							// Case 4: All remote actions happened AFTER all local pending actions.
							yield* Effect.logInfo(
								`Case 4: Latest pending action (${latestPendingAction.id}) is older than earliest remote action (${earliestRemoteAction.id}). Applying remote, then sending pending.`
							)

							// 1. Apply remote actions
							const appliedRemotes = yield* applyActionRecords(remoteActions)
							// 2. Send pending actions
							yield* sendLocalActions()
							// Return a combined list or decide on appropriate return value for this case
							// For now, returning applied remotes as they were processed first in this flow.
							// The pending actions are handled by _handleSendActions.
							return appliedRemotes
						} else {
							// Case 3: Actions are interleaved, concurrent, or remote is older/equal -> Reconciliation required.
							yield* Effect.logInfo(
								"Case 3: Actions interleaved or remote older than pending. Reconciliation required."
							)
							// Fetch ALL local actions for reconciliation context
							const allLocalActions = yield* actionRecordRepo.all()
							yield* reconcile(pendingActions, remoteActions, allLocalActions)

							// Send the newly created reconciled actions
							return yield* sendLocalActions()
						}
					} else {
						// Should not happen if hasPending and hasRemote are true, but handle defensively
						return yield* Effect.fail(
							new SyncError({
								message: "Could not determine latest pending or earliest remote clock."
							})
						)
					}
				}

				// Should be unreachable, but satisfy TypeScript
				return yield* Effect.dieMessage("Unreachable code reached in performSync")
			}).pipe(
				// Centralized error handling
				Effect.catchAll((error) =>
					Effect.gen(function* () {
						// Added Effect.gen wrapper
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
				const commonAncestorOpt = yield* rollbackToCommonAncestor().pipe(Effect.map(Option.fromNullable)) // Get Option<ActionRecord>
				const commonAncestor = Option.getOrNull(commonAncestorOpt) // Keep null for args if None
				yield* Effect.logDebug(
					`Rolled back to common ancestor during reconcile: ${JSON.stringify(commonAncestor)}`
				)

				// --- BEGIN FIX: Create RollbackAction ---
				// Get necessary info for the new action record
				const rollbackClock = yield* clockService.incrementClock // Get a new clock for the rollback action
				// We might be outside the main reconcile transaction here, but need a txid.
				// Getting the current one should suffice for associating the record,
				// even if the actual DB rollback happened in the SQL function's implicit transaction.
				const rollbackTxIdResult = yield* sql<{ txid: number }>`SELECT txid_current() as txid`
				const rollbackTransactionId = rollbackTxIdResult[0]?.txid

				if (!rollbackTransactionId) {
					// If we can't get a txid, something is wrong, fail the reconciliation.
					return yield* Effect.fail(
						new SyncError({ message: "Failed to get transaction ID for RollbackAction during reconcile" })
					)
				}

				// Create and insert the RollbackAction record
				const rollbackActionRecord = yield* actionRecordRepo.insert(
					ActionRecord.insert.make({
						_tag: "RollbackAction", // Use the specific tag for rollback actions
						client_id: clientId, // The client performing the rollback
						clock: rollbackClock, // The new clock timestamp for this action
						// Add timestamp to satisfy the schema, using the rollback action's own HLC timestamp
						args: { target_action_id: commonAncestor?.id ?? null, timestamp: rollbackClock.timestamp },
						synced: false, // This new action is initially unsynced
						transaction_id: rollbackTransactionId // Associate with the current transaction context
					})
				)
				yield* Effect.logInfo(`Created RollbackAction record: ${rollbackActionRecord.id}`)
				// --- END FIX ---

				const actionsToReplay = yield* actionRecordRepo.findUnappliedLocally() // Use new method
				yield* Effect.logDebug(
					`Final list of actions to REPLAY in reconcile: [${actionsToReplay.map((a: ActionRecord) => `${a.id} (${a._tag})`).join(", ")}]` // Added type for 'a'
				)
				// Now that we have rolled back to a comon ancestor, apply the actions in clock order
				// then check for any divergence, adding a SYNC action if needed
				yield* applyActionRecords(actionsToReplay)
				// Return the newly created actions as the result of reconciliation (as readonly)
				// Let the caller handle sending and marking as synced
				return yield* actionRecordRepo.allUnsynced()
			})

		const findRollbackTarget = (incomingActions: readonly ActionRecord[]) =>
			Effect.gen(function* () {
				const rollbacks = incomingActions.filter((a) => a._tag === "RollbackAction")
				// find oldest target of all rollback in the incoming actions
				//findByIds sorts by sortable_clock so we can take array head
				const oldestRollbackTarget = Array.head(
					yield* actionRecordRepo.findByIds(rollbacks.map((a: any) => a.args.target_action_id))
				)

				const pendingActions = yield* actionRecordRepo.findBySynced(false)

				const currentRollbackTarget = yield* findCommonAncestor()
				// Find the oldest target of either the incoming rollbacks or the current rollback target
				let rollbackTarget = Option.none<ActionRecord>()
				if (
					pendingActions.length > 0 &&
					incomingActions.length > 0 &&
					Option.isSome(oldestRollbackTarget) &&
					Option.isSome(currentRollbackTarget) &&
					oldestRollbackTarget.value.sortable_clock < currentRollbackTarget.value.sortable_clock
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
					// Skip applying rollback actions during the apply/replay phase
					// Their effect is already handled by the initial rollbackToCommonAncestor call.
					if (actionRecord._tag === "_Rollback") {
						yield* Effect.logTrace(
							// Changed to trace as it's less critical info now
							`Skipping application of Rollback action during apply phase: ${actionRecord.id}`
						)
						// Mark as applied locally as its effect (the rollback) is complete.
						yield* actionRecordRepo.markLocallyApplied(actionRecord.id) // Use new method
						appliedRemoteClocks.push(actionRecord.clock) // Still update clock based on its timestamp
						continue // Move to the next action
					}

					const actionCreator = actionRegistry.getActionCreator(actionRecord._tag)

					if (actionRecord._tag === "_InternalSyncApply") {
						// Apply SYNC action patches directly
						yield* Effect.logDebug(`Applying patches for received SYNC action: ${actionRecord.id}`)
						const syncAmrs = yield* actionModifiedRowRepo.findByActionRecordIds([actionRecord.id])
						if (syncAmrs.length > 0) {
							const amrIds = syncAmrs.map((amr) => amr.id)
							yield* sql`SELECT apply_forward_amr_batch(${sql.json(amrIds)})`
							yield* Effect.logDebug(
								`Applied forward patches for ${syncAmrs.length} AMRs associated with received SYNC action ${actionRecord.id}`
							)
						} else {
							yield* Effect.logWarning(
								`Received SYNC action ${actionRecord.id} had no associated ActionModifiedRows.`
							)
						}
						// Mark that a SYNC action was processed
					} else if (!actionCreator) {
						// Handle missing creator (should rollback transaction)
						return yield* Effect.fail(
							new SyncError({ message: `Missing action creator: ${actionRecord._tag}` })
						)
					} else {
						// Apply regular action logic
						yield* Effect.logDebug(
							`Applying logic for remote action: ${actionRecord.id} (${actionRecord._tag}) ${JSON.stringify(actionRecord.args)}`
						)

						yield* actionCreator(actionRecord.args).execute()
					}

					// Mark the received action (regular or SYNC) as applied locally
					yield* actionRecordRepo.markLocallyApplied(actionRecord.id) // Use new method
					yield* Effect.logDebug(`Marked remote action ${actionRecord.id} as applied locally.`)
					// Store clock for later HLC update
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

				// --- Add Logging Here ---
				yield* Effect.logDebug(`Comparing generated vs original patches for divergence check.`)
				yield* Effect.logDebug(
					`Generated Patches (${generatedPatches.length}): ${JSON.stringify(generatedPatches, null, 2)}`
				)
				yield* Effect.logDebug(
					`Original Patches (${originalPatches.length}): ${JSON.stringify(originalPatches, null, 2)}`
				)
				// --- End Logging ---

				// 6. Compare total generated patches vs. total original patches
				const arePatchesIdentical = compareActionModifiedRows(generatedPatches, originalPatches) // Use strict comparison

				yield* Effect.logDebug(
					`Overall Divergence check: Generated ${generatedPatches.length} patches, Original ${originalPatches.length} patches. Identical: ${arePatchesIdentical}`
				)

				if (arePatchesIdentical) {
					// 7a. No divergence OR a SYNC action was processed (implying divergence was handled):
					// Delete the placeholder SYNC record
					yield* Effect.logInfo("No overall divergence detected. Deleting placeholder SYNC action.")
					yield* actionRecordRepo.deleteById(syncRecord.id)
					// Cascading delete should handle AMRs associated with syncRecord.id
				} else {
					// 7b. Divergence detected AND no corrective SYNC action was received:
					// Keep the placeholder SYNC action, update its clock
					yield* Effect.logWarning(
						"Overall divergence detected (and no corrective SYNC received). Keeping placeholder SYNC action."
					)
					const newSyncClock = yield* clockService.incrementClock
					yield* Effect.logDebug(
						`Updating placeholder SYNC action ${syncRecord.id} clock due to divergence: ${JSON.stringify(newSyncClock)}`
					)
					yield* sql`UPDATE action_records SET clock = ${sql.json(newSyncClock)} WHERE id = ${syncRecord.id}`
					// The generated patches are already associated with syncRecord via transactionId by the triggers.
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
				// Call the SQL function
				// The SQL function now takes no arguments
				const result = yield* sql<ActionRecord>`SELECT * FROM find_common_ancestor()`

				// The function returns SETOF actions, so we expect 0 or 1 row.
				// Return the first element as an Option.
				return Array.head(result)
			}).pipe(Effect.withSpan("db.findCommonAncestor"))

		/**
		 * Start a background process to listen for sync events
		 */
		const startSyncListener = (): Effect.Effect<Fiber.RuntimeFiber<void>, never, never> =>
			Effect.gen(function* () {
				// TODO: Implement real-time sync listener using Electric-sql and pglite
				return yield* Effect.void.pipe(Effect.forever, Effect.forkDaemon)
			}).pipe(Effect.annotateLogs("clientId", clientId))

		/**
		 * Clean up old, synced action records to prevent unbounded growth.
		 * We retain records for up to one week by default
		 */
		const cleanupOldActionRecords = (retentionDays = 7) =>
			Effect.gen(function* () {
				// Delete action records older than the retention period that have been synced
				// Using direct SQL instead of the repository methods to avoid type errors
				yield* sql`
					DELETE FROM action_records
					WHERE synced = true
					AND created_at < (NOW() - INTERVAL '1 day' * ${retentionDays})
				`

				// Log completion for debugging
				yield* Effect.logInfo(`Cleaned up action records older than ${retentionDays} days`)

				// Return success
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
							// Re-throw the error so caller can decide how to handle it
							return yield* Effect.fail(
								new SyncError({
									message: `Failed to send actions to server: ${error.message}`,
									cause: error
								})
							)
						})
					)
				)

				// Mark the specific actions passed in (pending or reconciled) as synced
				for (const action of actionsToSend) {
					yield* actionRecordRepo.markAsSynced(action.id)
					yield* Effect.logDebug(
						`Marked action ${action.id} (${action._tag}) as synced after send.`
					)
				}

				// Update last_synced_clock based on the latest clock
				yield* clockService.updateLastSyncedClock()

				return actionsToSend // Return the actions that were handled
			}).pipe(
				// Catch potential errors from sendLocalActions or markAsSynced and map to SyncError
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
			startSyncListener,
			cleanupOldActionRecords
		}
	}),
	dependencies: [
		ActionRecordRepo.Default,
		ActionModifiedRowRepo.Default, // Add ActionModifiedRowRepo dependency
		SyncNetworkService.Default,
		ActionRegistry.Default // Added ActionRegistry
	]
}) {}
