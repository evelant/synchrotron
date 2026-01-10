import { PgLiteClient } from "@effect/sql-pglite"
import type { SqlError } from "@effect/sql/SqlError"
import { ActionModifiedRowRepo } from "@synchrotron/sync-core/ActionModifiedRowRepo" // Import Repo
import { ClockService } from "@synchrotron/sync-core/ClockService"
import type { ActionRecord } from "@synchrotron/sync-core/models"
import { ActionModifiedRow } from "@synchrotron/sync-core/models" // Import ActionModifiedRow model
import {
	NetworkRequestError,
	RemoteActionFetchError,
	SyncNetworkService
	// Remove TestNetworkState import from here, define it below
} from "@synchrotron/sync-core/SyncNetworkService"
import { Cause, Context, Effect, Layer, TestClock } from "effect"

// Define FetchResult type
interface FetchResult {
	actions: readonly ActionRecord[]
	modifiedRows: readonly ActionModifiedRow[]
}

// Define TestNetworkState interface including fetchResult
export interface TestNetworkState {
	/** Simulated network delay in milliseconds */
	networkDelay: number
	/** Whether network operations should fail */
	shouldFail: boolean
	/** Mocked result for fetchRemoteActions */
	fetchResult?: Effect.Effect<FetchResult, RemoteActionFetchError>
}

export class SyncNetworkServiceTestHelpers extends Context.Tag("SyncNetworkServiceTestHelpers")<
	SyncNetworkServiceTestHelpers,
	{
		setNetworkDelay: (delay: number) => Effect.Effect<void, never, never>
		setShouldFail: (fail: boolean) => Effect.Effect<void, never, never>
	}
>() {}
/**
 * Test implementation for controlled testing environment
 * Allows simulating network conditions and controlling action availability
 * with proper schema isolation
 */
export const createTestSyncNetworkServiceLayer = (
	clientId: string,
	_serverSql?: PgLiteClient.PgLiteClient,
	config: {
		initialState?: Partial<TestNetworkState> | undefined // Use the updated TestNetworkState
		simulateDelay?: boolean
	} = {}
) =>
	Layer.unwrapEffect(
		Effect.gen(function* () {
			// Removed explicit return type annotation
			const sql = yield* PgLiteClient.PgLiteClient // This is the CLIENT's SQL instance from the layer
			const clockService = yield* ClockService // Keep clockService dependency
			// Need the repo to fetch/insert ActionModifiedRow for conflict check
			const actionModifiedRowRepo = yield* ActionModifiedRowRepo
			const serverSql = _serverSql ?? sql

			// Initialize test state using the updated interface
			let state: TestNetworkState = {
				networkDelay: 0,
				shouldFail: false,
				...config.initialState // fetchResult will be included if provided in config
			}

			/**
			 * Set simulated network delay
			 */
			const setNetworkDelay = (delay: number) =>
				Effect.sync(() => {
					state.networkDelay = delay
				})

			/**
			 * Set whether network operations should fail
			 */
			const setShouldFail = (fail: boolean) =>
				Effect.sync(() => {
					state.shouldFail = fail
				})

			/**
			 * Get all actions AND their modified rows from the server schema
			 */
			const getServerData = (
				sinceServerIngestId: number
			): Effect.Effect<FetchResult, SqlError> => // Updated return type
				Effect.gen(function* () {
					// Log the database path being queried
					// @ts-expect-error - Accessing private property for debugging
					const dbPath = serverSql.client?.db?.path ?? "unknown"
					yield* Effect.logDebug(`getServerData: Querying server DB at ${dbPath}`)

					const actions = yield* serverSql<ActionRecord>`
							SELECT * FROM action_records
							WHERE client_id != ${clientId}
							AND server_ingest_id > ${sinceServerIngestId}
							ORDER BY server_ingest_id ASC, id ASC
	          			`

					yield* Effect.logDebug(
						`getServerData for ${clientId}: Found ${actions.length} actions on server. Raw result: ${JSON.stringify(actions)}`
					)

					let modifiedRows: readonly ActionModifiedRow[] = []
					if (actions.length > 0) {
						const actionIds = actions.map((a) => a.id)
						// Fetch corresponding modified rows from server schema
						modifiedRows = yield* serverSql<ActionModifiedRow>`
              SELECT * FROM action_modified_rows
              WHERE action_record_id IN ${sql.in(actionIds)}
            `
					}

					return { actions, modifiedRows } // Return both
				}).pipe(Effect.annotateLogs("clientId", `${clientId} (server simulation)`))

			const insertActionsOnServer = (
				incomingActions: readonly ActionRecord[],
				amrs: readonly ActionModifiedRow[]
			) =>
				Effect.gen(function* () {
					yield* Effect.logDebug(
						`insertActionsOnServer called by ${clientId} with ${incomingActions.length} actions: ${JSON.stringify(incomingActions.map((a) => a.id))}`
					)
					if (incomingActions.length === 0) {
						yield* Effect.logDebug("No incoming actions to insert on server.")
						return // Nothing to insert
					}
					// Fetch ActionModifiedRows associated with the incoming actions
					// --- PROBLEM: Fetching by action ID might fail due to transaction isolation ---
					const incomingActionIds = incomingActions.map((a) => a.id)

					yield* Effect.logDebug(`Checking conflicts for ${amrs.length} modified rows.`)
					if (amrs.length > 0) {
						const affectedRowKeys = amrs.map((r) => ({
							table_name: r.table_name, // Use correct property name
							row_id: r.row_id
						}))
						const rowConditions = affectedRowKeys.map(
							(
								key: { table_name: string; row_id: string } // Use correct property names
							) => serverSql`(amr.table_name = ${key.table_name} AND amr.row_id = ${key.row_id})`
						)

						// Find existing actions on the server that modify the same rows
						// Find the action record with the latest clock among the incoming actions
						const latestAction = incomingActions.reduce(
							(latestActionSoFar, currentAction) => {
								if (!latestActionSoFar) return currentAction // First item
								// Construct arguments for compareClock explicitly
								const latestArg = {
									clock: latestActionSoFar.clock,
									clientId: latestActionSoFar.client_id
								}
								const currentArg = { clock: currentAction.clock, clientId: currentAction.client_id }
								// Use compareClock which needs objects with clock and client_id
								return clockService.compareClock(currentArg, latestArg) > 0
									? currentAction // currentAction is newer
									: latestActionSoFar // latestActionSoFar is newer or concurrent/equal
							},
							null as ActionRecord | null
						)

						const latestIncomingClock = latestAction?.clock // Extract the clock from the latest action

						if (!latestIncomingClock) {
							return yield* Effect.die("Incoming actions must have a clock")
						}
						yield* Effect.logDebug(
							`Checking for server actions newer than latest incoming clock ${JSON.stringify(latestIncomingClock)} affecting rows: ${JSON.stringify(affectedRowKeys)}`
						)

						// --- BEGIN SERVER-SIDE ROLLBACK SIMULATION ---
						const incomingRollbacks = incomingActions.filter((a) => a._tag === "RollbackAction")
						if (incomingRollbacks.length > 0) {
							yield* Effect.logInfo(
								`Server Simulation: Received ${incomingRollbacks.length} RollbackAction(s). Determining oldest target.`
							)
							const rollbackTargets = incomingRollbacks.map((rb) => rb.args["target_action_id"])
							const hasGenesisRollback = rollbackTargets.some((id) => id === null)
							const targetActionIds = rollbackTargets.filter(
								(id): id is string => typeof id === "string"
							)

							if (hasGenesisRollback) {
								yield* Effect.logInfo(
									"Server Simulation: Received RollbackAction targeting genesis. Rolling back server state to genesis."
								)
								yield* serverSql`SELECT rollback_to_action(${null})`
							} else if (targetActionIds.length > 0) {
								// Fetch the target actions to compare their clocks
								const targetActions = yield* serverSql<ActionRecord>`
									SELECT * FROM action_records WHERE id IN ${sql.in(targetActionIds)}
								`

								if (targetActions.length > 0) {
									// Sort targets by clock to find the oldest
									const sortedTargets = targetActions
										// Map to the structure expected by compareClock
										.map((a) => ({ clock: a.clock, clientId: a.client_id, id: a.id }))
										.sort((a, b) => clockService.compareClock(a, b)) // Sort ascending (oldest first)

									const oldestTargetAction = sortedTargets[0]
									if (oldestTargetAction) {
										yield* Effect.logInfo(
											`Server Simulation: Rolling back server state to target action: ${oldestTargetAction.id}`
										)
										// Call the rollback function on the server DB
										yield* serverSql`SELECT rollback_to_action(${oldestTargetAction.id})`
									} else {
										// Should not happen if targetActions.length > 0
										yield* Effect.logWarning(
											"Server Simulation: Could not determine the oldest target action for rollback."
										)
									}
								} else {
									yield* Effect.logWarning(
										`Server Simulation: Received RollbackAction(s) but could not find target action(s) with IDs: ${targetActionIds.join(", ")}`
									)
								}
							} else {
								yield* Effect.logWarning(
									"Server Simulation: Received RollbackAction(s) without a valid target_action_id."
								)
							}
						}
						// --- END SERVER-SIDE ROLLBACK SIMULATION ---

						// --- Original Conflict Check Logic (remains the same) ---
						yield* Effect.logDebug(
							`Checking for conflicting server actions newer than ${JSON.stringify(
								latestIncomingClock // Use latest clock here
							)} affecting rows: ${JSON.stringify(affectedRowKeys)}`
						)

						const conflictingServerActions = yield* serverSql<ActionRecord>`
							WITH conflicting_rows AS (
							SELECT DISTINCT amr.action_record_id
								FROM action_modified_rows amr
								WHERE ${sql.or(rowConditions)}
							)
								SELECT ar.*
								FROM action_records ar
								JOIN conflicting_rows cr ON ar.id = cr.action_record_id
								WHERE compare_hlc(ar.clock, ${sql.json(
									latestIncomingClock // Compare against latest clock
								)}) > 0
								ORDER BY ar.clock_time_ms ASC, ar.clock_counter ASC, ar.client_id ASC, ar.id ASC
							`

						yield* Effect.logDebug(
							`Found ${conflictingServerActions.length} conflicting server actions: ${JSON.stringify(conflictingServerActions.map((a) => a.id))}`
						)
						if (conflictingServerActions.length > 0) {
							yield* Effect.logWarning(
								`Conflict detected on server simulation: ${conflictingServerActions.length} newer actions affect the same rows.`
							)
							return yield* Effect.fail(
								new NetworkRequestError({
									message: `Conflict detected: ${conflictingServerActions.length} newer server actions affect the same rows.`,
									cause: { conflictingActions: conflictingServerActions }
								})
							)
						}
					}
					// --- End Conflict Check ---

					// Wrap server-side inserts and patch application in a transaction
					yield* Effect.gen(function* () {
						// If no conflicts, insert ActionRecords
						for (const actionRecord of incomingActions) {
							yield* Effect.logInfo(
								`Inserting action ${actionRecord.id} into server schema, created_at: ${actionRecord.created_at}`
							)
							yield* serverSql`
								INSERT INTO action_records (
									server_ingest_id,
									id,
									client_id,
									_tag,
									args,
									clock,
									synced,
									transaction_id,
									created_at
								)
								VALUES (
									nextval('action_records_server_ingest_id_seq'),
									${actionRecord.id},
									${actionRecord.client_id},
									${actionRecord._tag},
									${sql.json(actionRecord.args)},
									${sql.json(actionRecord.clock)},
									true,
									${actionRecord.transaction_id},
									${new Date(actionRecord.created_at)}
								)
								ON CONFLICT (id) DO NOTHING
							`
						}

						// Then insert the corresponding ActionModifiedRows
						for (const modifiedRow of amrs) {
							yield* Effect.logDebug(
								`Inserting AMR ${modifiedRow.id} for action ${modifiedRow.action_record_id} into server schema.`
							)
							yield* serverSql`INSERT INTO action_modified_rows ${sql.insert({
								...modifiedRow,
								// Ensure patches are JSON
								forward_patches: sql.json(modifiedRow.forward_patches),
								reverse_patches: sql.json(modifiedRow.reverse_patches)
							})}
								ON CONFLICT (id) DO NOTHING
								-- Or potentially ON CONFLICT (table_name, row_id, action_record_id) DO NOTHING depending on unique constraints`
						}

						// Apply forward patches on the server simulation
						if (amrs.length > 0) {
							// --- BEGIN LOGGING ---
							// Filter out RollbackActions before applying forward patches
							const nonRollbackActions = incomingActions.filter((a) => a._tag !== "RollbackAction")
							const nonRollbackActionIds = nonRollbackActions.map((a) => a.id)

							// Create a map of action IDs to their tags for efficient lookup
							// const actionTagMap = new Map(incomingActions.map((action) => [action.id, action._tag]))

							// Filter out AMRs associated with RollbackAction before applying forward patches
							const amrsToApplyForward = amrs.filter(
								// (amr) => actionTagMap.get(amr.action_record_id) !== "RollbackAction"
								(amr) => nonRollbackActionIds.includes(amr.action_record_id) // Filter based on non-rollback action IDs
							)

							// Sort AMRs based on the HLC of their corresponding ActionRecord
							const actionClockMap = new Map(
								nonRollbackActions.map((action) => [action.id, action.clock]) // Use nonRollbackActions here
							)
							const sortedAmrs = [...amrsToApplyForward].sort((a, b) => {
								// Sort only the AMRs to be applied
								const clockA = actionClockMap.get(a.action_record_id)
								const clockB = actionClockMap.get(b.action_record_id)
								// Need client IDs for proper comparison, assume they are available on actions
								// This might need adjustment if client_id isn't readily available here
								// For simplicity, using only clock comparison; refine if needed.
								if (!clockA || !clockB) return 0 // Should not happen if data is consistent
								// Assuming compareHlc function is accessible or reimplement comparison logic
								// For now, just comparing timestamps as a proxy for HLC order
								return clockA.timestamp < clockB.timestamp
									? -1
									: clockA.timestamp > clockB.timestamp
										? 1
										: 0
							})
							const sortedAmrIdsToApply = sortedAmrs.map((amr) => amr.id) // Get IDs from the sorted list
							// Log the exact order of AMR IDs being sent to the batch function
							yield* Effect.logDebug(
								`Server Simulation: Applying forward patches for ${sortedAmrIdsToApply.length} AMRs in HLC order.`
							)
							yield* Effect.logDebug(
								`Server Simulation: Sorted AMR IDs to apply: ${JSON.stringify(sortedAmrIdsToApply)}`
							)
							// Use serverSql instance to apply patches to the server schema
							// Disable trigger for this session using set_config
							yield* serverSql`SELECT set_config('sync.disable_trigger', 'true', false)`
							try {
								yield* serverSql`SELECT apply_forward_amr_batch(${sql.json(sortedAmrIdsToApply)})`
							} finally {
								// Ensure trigger is re-enabled even if batch fails
								yield* serverSql`SELECT set_config('sync.disable_trigger', 'false', false)`
							}
						}
					}).pipe(serverSql.withTransaction) // Wrap server operations in a transaction

					yield* Effect.logInfo(
						`Successfully inserted ${incomingActions.length} actions and ${amrs.length} modified rows into server schema.`
					)
				}).pipe(Effect.annotateLogs("clientId", `${clientId} (server simulation)`))

			// Define the service implementation INSIDE the Effect.gen scope
			const service: SyncNetworkService = SyncNetworkService.of({
				_tag: "SyncNetworkService",
				fetchRemoteActions: () =>
					// Interface expects only RemoteActionFetchError
					Effect.gen(function* () {
						const sinceServerIngestId = yield* clockService.getLastSeenServerIngestId
						yield* Effect.logInfo(
							`Fetching remote data since server_ingest_id=${sinceServerIngestId} for client ${clientId}`
						)
						if (state.shouldFail && !state.fetchResult) {
							// Only fail if no mock result provided
							return yield* Effect.fail(
								new RemoteActionFetchError({
									message: "Simulated network failure"
								})
							)
						}

						if (state.networkDelay > 0 && !state.fetchResult) {
							// Only delay if no mock result
							yield* TestClock.adjust(state.networkDelay)
						}

						// Use mocked result if provided, otherwise fetch from server
						const fetchedData = state.fetchResult
							? yield* state.fetchResult
							: yield* getServerData(sinceServerIngestId)

						// Simulate ElectricSQL sync: Insert fetched actions AND modified rows directly into the client's DB
						// Wrap inserts in an effect to catch SqlError
						yield* Effect.gen(function* () {
							if (fetchedData.actions.length > 0 || fetchedData.modifiedRows.length > 0) {
								// Check both
								yield* Effect.logDebug(
									`Simulating electric sync: Inserting ${fetchedData.actions.length} actions and ${fetchedData.modifiedRows.length} rows into client ${clientId}`
								)
								// Insert Actions
								for (const action of fetchedData.actions) {
									// Use client's sql instance
									yield* sql`INSERT INTO action_records ${sql.insert({
										// Explicitly list fields instead of spreading
										id: action.id,
										server_ingest_id: action.server_ingest_id,
										_tag: action._tag,
										client_id: action.client_id,
											transaction_id: action.transaction_id,
											clock: sql.json(action.clock), // Ensure clock is JSON
											args: sql.json(action.args), // Ensure args are JSON
											created_at: new Date(action.created_at),
											synced: true // Mark as synced locally
										})} ON CONFLICT (id) DO UPDATE SET synced = true` // Update status on conflict
									}

								// Insert Modified Rows
								for (const row of fetchedData.modifiedRows) {
									// Use client's sql instance
									yield* sql`INSERT INTO action_modified_rows ${sql.insert({
										...row,
										forward_patches: sql.json(row.forward_patches), // Ensure patches are JSON
										reverse_patches: sql.json(row.reverse_patches) // Ensure patches are JSON
									})} ON CONFLICT (id) DO NOTHING` // Ignore duplicates
								}
							}
						}).pipe(
							// Catch SqlError from inserts and map it to RemoteActionFetchError
							Effect.catchTag("SqlError", (sqlError) =>
								Effect.fail(
									new RemoteActionFetchError({
										message: `Simulated sync failed during DB insert: ${sqlError.message}`,
										cause: sqlError
									})
								)
							)
						)

						// Return the fetched data so SyncService knows what was received
						return fetchedData
					}).pipe(
						Effect.catchAllCause((error) =>
							Effect.fail(
								new RemoteActionFetchError({
									message: `Failed to fetch remote actions ${Cause.pretty(error)}`,
									cause: error
								})
							)
						),
						Effect.annotateLogs("clientId", clientId),
						Effect.withLogSpan("test fetchRemoteActions")
					),

				sendLocalActions: (actions: readonly ActionRecord[], amrs: readonly ActionModifiedRow[]) =>
					Effect.gen(function* () {
						if (state.shouldFail) {
							return yield* Effect.fail(
								new NetworkRequestError({
									message: "Simulated network failure"
								})
							)
						}

						if (state.networkDelay > 0) {
							yield* TestClock.adjust(state.networkDelay)
						}

						yield* Effect.logInfo(
							`Sending ${actions.length} local actions to server ${JSON.stringify(actions)}`
						)

						// Check if we have any actions to process
						if (actions.length === 0) {
							yield* Effect.logInfo("No actions to process")
							return true
						}

						yield* insertActionsOnServer(actions, amrs)
						yield* Effect.logInfo(`Sent ${actions.length} local actions to server`)
						return true
					}).pipe(
						// Convert SqlError to NetworkRequestError to match the expected error
						Effect.catchTags({
							SqlError: (error: SqlError) =>
								Effect.fail(
									new NetworkRequestError({
										message: `Database error while sending actions to server: ${error.message}`,
										cause: error
									})
								)
						}),
						Effect.annotateLogs("clientId", clientId),
						Effect.withLogSpan("test sendLocalActions")
					)
			})

			// Test helper methods
			const testHelpers = SyncNetworkServiceTestHelpers.of({
				setNetworkDelay,
				setShouldFail
			})
			return Layer.merge(
				Layer.succeed(SyncNetworkService, service),
				Layer.succeed(SyncNetworkServiceTestHelpers, testHelpers)
			)
		})
	)
