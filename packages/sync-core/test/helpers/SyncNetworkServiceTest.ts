import { PgliteClient } from "@effect/sql-pglite"
import { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { ActionModifiedRowRepo } from "@synchrotron/sync-core/ActionModifiedRowRepo" // Import Repo
import { ClockService } from "@synchrotron/sync-core/ClockService"
import type { ActionRecord } from "@synchrotron/sync-core/models"
import { ActionModifiedRow } from "@synchrotron/sync-core/models" // Import ActionModifiedRow model
import {
	FetchRemoteActionsCompacted,
	type FetchResult,
	NetworkRequestError,
	type BootstrapSnapshot,
	RemoteActionFetchError,
	SendLocalActionsBehindHead,
	type SendLocalActionsFailure,
	SyncNetworkService
	// Remove TestNetworkState import from here, define it below
} from "@synchrotron/sync-core/SyncNetworkService"
import { Context, Effect, Layer, TestClock } from "effect"

// Define TestNetworkState interface including fetchResult
export interface TestNetworkState {
	/** Simulated network delay in milliseconds */
	networkDelay: number
	/** Whether network operations should fail */
	shouldFail: boolean
	/** Mocked result for fetchRemoteActions */
	fetchResult:
		| Effect.Effect<FetchResult, RemoteActionFetchError | FetchRemoteActionsCompacted, never>
		| undefined
	/** Mocked result for fetchBootstrapSnapshot */
	bootstrapSnapshot: Effect.Effect<BootstrapSnapshot, RemoteActionFetchError, never> | undefined
	/**
	 * Optional queue of mocked `sendLocalActions` results.
	 * When non-empty, each send call consumes one result (FIFO).
	 */
	sendResults: Array<Effect.Effect<boolean, SendLocalActionsFailure | NetworkRequestError, never>>
}

export interface SyncNetworkServiceTestHelpersService {
	readonly setNetworkDelay: (delay: number) => Effect.Effect<void, never, never>
	readonly setShouldFail: (fail: boolean) => Effect.Effect<void, never, never>
	readonly setFetchResult: (
		fetchResult: TestNetworkState["fetchResult"]
	) => Effect.Effect<void, never, never>
	readonly setBootstrapSnapshot: (
		bootstrapSnapshot: TestNetworkState["bootstrapSnapshot"]
	) => Effect.Effect<void, never, never>
	readonly setSendResults: (
		results: ReadonlyArray<Effect.Effect<boolean, SendLocalActionsFailure | NetworkRequestError, never>>
	) => Effect.Effect<void, never, never>
}

export class SyncNetworkServiceTestHelpers extends Context.Tag("SyncNetworkServiceTestHelpers")<
	SyncNetworkServiceTestHelpers,
	SyncNetworkServiceTestHelpersService
>() {}
/**
 * Test implementation for controlled testing environment
 * Allows simulating network conditions and controlling action availability
 * with proper schema isolation
 */
export const createTestSyncNetworkServiceLayer = (
	clientId: string,
	_serverSql?: PgliteClient.PgliteClient,
	config: {
		initialState?: Partial<TestNetworkState> | undefined // Use the updated TestNetworkState
		simulateDelay?: boolean
	} = {}
) =>
	Layer.unwrapEffect(
		Effect.gen(function* () {
			// Removed explicit return type annotation
			const sql = yield* SqlClient.SqlClient // This is the CLIENT's SQL instance from the layer
			const clockService = yield* ClockService // Keep clockService dependency
			// Need the repo to fetch/insert ActionModifiedRow for conflict check
			const actionModifiedRowRepo = yield* ActionModifiedRowRepo
			const serverSql = _serverSql ?? (yield* PgliteClient.PgliteClient)

			const clientJson = (value: unknown) =>
				typeof (sql as any).json === "function"
					? (sql as any).json(value)
					: typeof value === "string"
						? value
						: JSON.stringify(value)

			// Initialize test state using the updated interface
			let state: TestNetworkState = {
				networkDelay: 0,
				shouldFail: false,
				fetchResult: undefined,
				bootstrapSnapshot: undefined,
				sendResults: [],
				...config.initialState // fetchResult will be included if provided in config
			}
			state.sendResults = state.sendResults ?? []

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
			 * Override fetchRemoteActions with a mocked result (or clear the override).
			 */
			const setFetchResult = (fetchResult: TestNetworkState["fetchResult"]) =>
				Effect.sync(() => {
					state.fetchResult = fetchResult
				})

			/**
			 * Override fetchBootstrapSnapshot with a mocked result (or clear the override).
			 */
			const setBootstrapSnapshot = (bootstrapSnapshot: TestNetworkState["bootstrapSnapshot"]) =>
				Effect.sync(() => {
					state.bootstrapSnapshot = bootstrapSnapshot
				})

			const setSendResults = (
				results: ReadonlyArray<Effect.Effect<boolean, SendLocalActionsFailure | NetworkRequestError, never>>
			) =>
				Effect.sync(() => {
					state.sendResults = [...results]
				})

			/**
			 * Get all actions AND their modified rows from the server schema
			 */
			const getServerData = (
				sinceServerIngestId: number,
				includeSelf: boolean = false
			): Effect.Effect<FetchResult, SqlError | FetchRemoteActionsCompacted> => // Updated return type
				Effect.gen(function* () {
					// Log the database path being queried
					// @ts-expect-error - Accessing private property for debugging
					const dbPath = serverSql.client?.db?.path ?? "unknown"
					yield* Effect.logDebug(
						`getServerData: Querying server DB at ${dbPath} (since=${sinceServerIngestId}, includeSelf=${includeSelf})`
					)

					const epochRows = yield* serverSql<{ readonly server_epoch: string }>`
						SELECT server_epoch::text AS server_epoch
						FROM sync_server_meta
						WHERE id = 1
					`
					const serverEpoch = epochRows[0]?.server_epoch ?? "test-epoch"

					const minRows = yield* serverSql<{
						readonly min_server_ingest_id: number | string | bigint | null
					}>`
						SELECT COALESCE(MIN(server_ingest_id), 0) AS min_server_ingest_id
						FROM action_records
					`
					const minRetainedServerIngestId = Number(minRows[0]?.min_server_ingest_id ?? 0)
					if (sinceServerIngestId + 1 < minRetainedServerIngestId) {
						return yield* Effect.fail(
							new FetchRemoteActionsCompacted({
								message:
									"Requested action log delta is older than the server's retained history (compacted)",
								sinceServerIngestId,
								minRetainedServerIngestId,
								serverEpoch
							})
						)
					}

					const actions = yield* (includeSelf
						? serverSql<ActionRecord>`
								SELECT * FROM action_records
								WHERE server_ingest_id > ${sinceServerIngestId}
								ORDER BY server_ingest_id ASC, id ASC
							`
						: serverSql<ActionRecord>`
								SELECT * FROM action_records
								WHERE client_id != ${clientId}
								AND server_ingest_id > ${sinceServerIngestId}
								ORDER BY server_ingest_id ASC, id ASC
							`)

					yield* Effect.logDebug(
						`getServerData for ${clientId}: Found ${actions.length} actions on server. Raw result: ${JSON.stringify(actions)}`
					)

					let modifiedRows: readonly ActionModifiedRow[] = []
					if (actions.length > 0) {
						const actionIds = actions.map((a) => a.id)
						// Fetch corresponding modified rows from server schema
						modifiedRows = yield* serverSql<ActionModifiedRow>`
              SELECT * FROM action_modified_rows
              WHERE action_record_id IN ${serverSql.in(actionIds)}
							ORDER BY action_record_id, sequence ASC, id ASC
            `
					}

					return {
						serverEpoch,
						minRetainedServerIngestId,
						actions,
						modifiedRows
					} satisfies FetchResult
				}).pipe(Effect.annotateLogs("clientId", `${clientId} (server simulation)`))

				const insertActionsOnServer = (
					incomingActions: readonly ActionRecord[],
					amrs: readonly ActionModifiedRow[],
					basisServerIngestId: number
				) =>
					Effect.gen(function* () {
						if (incomingActions.length === 0) return

					type ReplayKey = {
						readonly timeMs: number
						readonly counter: number
						readonly clientId: string
						readonly id: string
					}

					const toNumber = (value: unknown): number => {
						if (typeof value === "number") return value
						if (typeof value === "bigint") return Number(value)
						if (typeof value === "string") return Number(value)
						return Number(value)
					}

					const compareReplayKey = (a: ReplayKey, b: ReplayKey): number => {
						if (a.timeMs !== b.timeMs) return a.timeMs < b.timeMs ? -1 : 1
						if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1
						if (a.clientId !== b.clientId) return a.clientId < b.clientId ? -1 : 1
						if (a.id !== b.id) return a.id < b.id ? -1 : 1
						return 0
					}

					const replayKeyForAction = (action: ActionRecord): ReplayKey => ({
						timeMs: toNumber(action.clock.timestamp ?? 0),
						counter: toNumber(action.clock.vector?.[action.client_id] ?? 0),
						clientId: action.client_id,
						id: action.id
					})

						const serverJson = (value: unknown) =>
							typeof value === "string" ? value : serverSql.json(value)

						const incomingActionIdSet = new Set(incomingActions.map((a) => a.id))

						// Simplified correctness gate: only accept uploads when the client is at the current
						// server ingestion head (for actions visible to it, excluding its own).
						const unseen = yield* serverSql<{
							readonly id: string
							readonly server_ingest_id: number | string
						}>`
							SELECT id, server_ingest_id
							FROM action_records
							WHERE client_id != ${clientId}
							AND server_ingest_id > ${basisServerIngestId}
							ORDER BY server_ingest_id ASC, id ASC
							LIMIT 1
						`
							if (unseen.length > 0) {
								const first = unseen[0]
								return yield* Effect.fail(
									new SendLocalActionsBehindHead({
										message:
											"Client is behind the server ingestion head. Fetch remote actions, reconcile locally, then retry upload.",
										basisServerIngestId,
										firstUnseenActionId: first?.id ?? undefined,
										firstUnseenServerIngestId: first ? toNumber(first.server_ingest_id) : basisServerIngestId
									})
								)
							}

						// Insert ActionRecords and AMRs idempotently.
						for (const actionRecord of incomingActions) {
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
							) VALUES (
								nextval('action_records_server_ingest_id_seq'),
								${actionRecord.id},
								${actionRecord.client_id},
								${actionRecord._tag},
								${serverJson(actionRecord.args)},
								${serverJson(actionRecord.clock)},
								1,
								${actionRecord.transaction_id},
								${new Date(actionRecord.created_at).toISOString()}
							)
							ON CONFLICT (id) DO NOTHING
						`
					}

					for (const modifiedRow of amrs) {
						if (incomingActionIdSet.has(modifiedRow.action_record_id) === false) continue
						yield* serverSql`
								INSERT INTO action_modified_rows (
									id,
									table_name,
									row_id,
									action_record_id,
									audience_key,
									operation,
									forward_patches,
									reverse_patches,
									sequence
								) VALUES (
									${modifiedRow.id},
									${modifiedRow.table_name},
									${modifiedRow.row_id},
									${modifiedRow.action_record_id},
									${modifiedRow.audience_key},
									${modifiedRow.operation},
									${serverJson(modifiedRow.forward_patches)},
									${serverJson(modifiedRow.reverse_patches)},
									${modifiedRow.sequence}
								)
							ON CONFLICT (id) DO NOTHING
						`
					}

					// Rollback markers are patch-less replay hints: roll back to the oldest target (or genesis).
					const incomingRollbacks = incomingActions.filter((a) => a._tag === "RollbackAction")
					let forcedRollbackTarget: string | null | undefined = undefined
					if (incomingRollbacks.length > 0) {
						const targets = incomingRollbacks.map((rb) => rb.args["target_action_id"] as string | null)
						const hasGenesis = targets.some((t) => t === null)
						if (hasGenesis) {
							forcedRollbackTarget = null
						} else {
							const targetIds = targets.filter((t): t is string => typeof t === "string" && t.length > 0)
							if (targetIds.length > 0) {
								const targetRows = yield* serverSql<{
									readonly id: string
									readonly clock_time_ms: number | string
									readonly clock_counter: number | string
									readonly client_id: string
								}>`
									SELECT id, clock_time_ms, clock_counter, client_id
									FROM action_records
									WHERE id IN ${serverSql.in(targetIds)}
								`
								if (targetRows.length !== targetIds.length) {
									return yield* Effect.die(
										`Rollback target action(s) not found on server: ${targetIds.join(", ")}`
									)
								}
								const oldest = [...targetRows].sort((a, b) =>
									compareReplayKey(
										{
											timeMs: toNumber(a.clock_time_ms),
											counter: toNumber(a.clock_counter),
											clientId: a.client_id,
											id: a.id
										},
										{
											timeMs: toNumber(b.clock_time_ms),
											counter: toNumber(b.clock_counter),
											clientId: b.client_id,
											id: b.id
										}
									)
								)[0]
								forcedRollbackTarget = oldest?.id
							}
						}
					}

					const getLatestApplied = () =>
						serverSql<{
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

					const getEarliestUnappliedWithPatches = () =>
						serverSql<{
							readonly id: string
							readonly clock_time_ms: number | string
							readonly clock_counter: number | string
							readonly client_id: string
						}>`
							SELECT ar.id, ar.clock_time_ms, ar.clock_counter, ar.client_id
							FROM action_records ar
							JOIN action_modified_rows amr ON amr.action_record_id = ar.id
							LEFT JOIN local_applied_action_ids la ON la.action_record_id = ar.id
							WHERE la.action_record_id IS NULL
							AND ar._tag != 'RollbackAction'
							GROUP BY ar.id, ar.clock_time_ms, ar.clock_counter, ar.client_id
							ORDER BY ar.clock_time_ms ASC, ar.clock_counter ASC, ar.client_id ASC, ar.id ASC
							LIMIT 1
						`.pipe(Effect.map((rows) => rows[0] ?? null))

					const findPredecessorId = (key: ReplayKey) =>
						serverSql<{ readonly id: string }>`
							SELECT id
							FROM action_records
							WHERE (clock_time_ms, clock_counter, client_id, id) < (${key.timeMs}, ${key.counter}, ${key.clientId}, ${key.id})
							ORDER BY clock_time_ms DESC, clock_counter DESC, client_id DESC, id DESC
							LIMIT 1
						`.pipe(Effect.map((rows) => rows[0]?.id ?? null))

					const applyAllUnapplied = () =>
						Effect.acquireUseRelease(
							serverSql`SELECT set_config('sync.disable_trigger', 'true', true)`,
							() =>
								Effect.gen(function* () {
									const unappliedActions = yield* serverSql<{
										readonly id: string
										readonly clock_time_ms: number | string
										readonly clock_counter: number | string
										readonly client_id: string
									}>`
										SELECT ar.id, ar.clock_time_ms, ar.clock_counter, ar.client_id
										FROM action_records ar
										JOIN action_modified_rows amr ON amr.action_record_id = ar.id
										LEFT JOIN local_applied_action_ids la ON la.action_record_id = ar.id
										WHERE la.action_record_id IS NULL
										AND ar._tag != 'RollbackAction'
										GROUP BY ar.id, ar.clock_time_ms, ar.clock_counter, ar.client_id
										ORDER BY ar.clock_time_ms ASC, ar.clock_counter ASC, ar.client_id ASC, ar.id ASC
									`

									for (const actionRow of unappliedActions) {
										const actionId = actionRow.id
										const amrIds = yield* serverSql<{ readonly id: string }>`
											SELECT id
											FROM action_modified_rows
											WHERE action_record_id = ${actionId}
											ORDER BY sequence ASC, id ASC
										`.pipe(Effect.map((rows) => rows.map((r) => r.id)))

										if (amrIds.length === 0) {
											yield* serverSql`INSERT INTO local_applied_action_ids (action_record_id) VALUES (${actionId}) ON CONFLICT DO NOTHING`
											continue
										}

										yield* serverSql`SELECT apply_forward_amr_batch(${serverSql.array(amrIds)})`
										yield* serverSql`INSERT INTO local_applied_action_ids (action_record_id) VALUES (${actionId}) ON CONFLICT DO NOTHING`
									}
								}),
							() =>
								serverSql`SELECT set_config('sync.disable_trigger', 'false', true)`.pipe(
									Effect.catchAll(Effect.logError)
								)
						)

					const materialize = (initialRollbackTarget: string | null | undefined) =>
						Effect.gen(function* () {
							if (initialRollbackTarget !== undefined) {
								yield* serverSql`SELECT rollback_to_action(${initialRollbackTarget})`
							}

							while (true) {
								const earliest = yield* getEarliestUnappliedWithPatches()
								if (!earliest) return
								const latestApplied = yield* getLatestApplied()
								if (!latestApplied) {
									yield* applyAllUnapplied()
									return
								}

								const earliestKey: ReplayKey = {
									timeMs: toNumber(earliest.clock_time_ms),
									counter: toNumber(earliest.clock_counter),
									clientId: earliest.client_id,
									id: earliest.id
								}
								const latestKey: ReplayKey = {
									timeMs: toNumber(latestApplied.clock_time_ms),
									counter: toNumber(latestApplied.clock_counter),
									clientId: latestApplied.client_id,
									id: latestApplied.id
								}

								if (compareReplayKey(earliestKey, latestKey) > 0) {
									yield* applyAllUnapplied()
									return
								}

								const predecessorId = yield* findPredecessorId(earliestKey)
								yield* serverSql`SELECT rollback_to_action(${predecessorId})`
							}
						})

					yield* materialize(forcedRollbackTarget)
				}).pipe(serverSql.withTransaction, Effect.annotateLogs("clientId", `${clientId} (server simulation)`))

			// Define the service implementation INSIDE the Effect.gen scope
				const service: SyncNetworkService = SyncNetworkService.of({
					_tag: "SyncNetworkService",
					fetchBootstrapSnapshot: () =>
						Effect.gen(function* () {
							if (state.shouldFail && !state.bootstrapSnapshot) {
								return yield* Effect.fail(
									new RemoteActionFetchError({ message: "Simulated network failure" })
								)
							}

							if (state.networkDelay > 0 && !state.bootstrapSnapshot) {
								yield* TestClock.adjust(state.networkDelay)
							}

							if (!state.bootstrapSnapshot) {
								return yield* Effect.fail(
									new RemoteActionFetchError({
										message:
											"Bootstrap snapshot is not configured for SyncNetworkServiceTest (set via SyncNetworkServiceTestHelpers.setBootstrapSnapshot)"
									})
								)
							}

							return yield* state.bootstrapSnapshot
						}).pipe(
							Effect.mapError(
								(error) =>
									new RemoteActionFetchError({
										message: error instanceof Error ? error.message : String(error),
										cause: error
									})
							)
						),
					fetchRemoteActions: (): Effect.Effect<
						FetchResult,
						RemoteActionFetchError | FetchRemoteActionsCompacted,
						never
					> =>
						Effect.gen(function* () {
								const sinceServerIngestId = yield* clockService.getLastSeenServerIngestId

							const [localState] = yield* sql<{ readonly has_any_action_records: boolean | 0 | 1 }>`
								SELECT EXISTS (SELECT 1 FROM action_records LIMIT 1) as has_any_action_records
							`
								const hasAnyActionRecords =
									typeof localState?.has_any_action_records === "boolean"
										? localState.has_any_action_records
										: localState?.has_any_action_records === 1
				const includeSelf = !hasAnyActionRecords && sinceServerIngestId === 0
				const effectiveSinceServerIngestId = includeSelf ? 0 : sinceServerIngestId
				yield* Effect.logInfo(
					`Fetching remote data since server_ingest_id=${effectiveSinceServerIngestId} for client ${clientId} (includeSelf=${includeSelf})`
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
								: yield* getServerData(effectiveSinceServerIngestId, includeSelf)

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
										clock: clientJson(action.clock),
										args: clientJson(action.args),
										created_at: new Date(action.created_at).toISOString(),
										synced: 1 // Mark as synced locally
									})} ON CONFLICT (id) DO UPDATE SET synced = 1` // Update status on conflict
								}

								// Insert Modified Rows
								for (const row of fetchedData.modifiedRows) {
									// Use client's sql instance
									yield* sql`INSERT INTO action_modified_rows ${sql.insert({
										...row,
										forward_patches: clientJson(row.forward_patches),
										reverse_patches: clientJson(row.reverse_patches)
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
						Effect.catchAll(
							(error): Effect.Effect<never, RemoteActionFetchError | FetchRemoteActionsCompacted, never> =>
								error instanceof FetchRemoteActionsCompacted
									? Effect.fail(error)
									: Effect.fail(
											new RemoteActionFetchError({
												message: `Failed to fetch remote actions: ${
													error instanceof Error ? error.message : String(error)
												}`,
												cause: error
											})
										)
						),
							Effect.annotateLogs("clientId", clientId),
							Effect.withLogSpan("test fetchRemoteActions")
						),

					sendLocalActions: (
						actions: readonly ActionRecord[],
						amrs: readonly ActionModifiedRow[],
						basisServerIngestId: number
						) =>
							Effect.gen(function* () {
								const nextSend = state.sendResults.shift()
								if (nextSend) {
									return yield* nextSend
								}

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
								`Sending ${actions.length} local actions to server (basisServerIngestId=${basisServerIngestId}) ${JSON.stringify(actions)}`
							)

						// Check if we have any actions to process
						if (actions.length === 0) {
							yield* Effect.logInfo("No actions to process")
							return true
						}

							yield* insertActionsOnServer(actions, amrs, basisServerIngestId)
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
					setShouldFail,
					setFetchResult,
					setBootstrapSnapshot,
					setSendResults
				})
			return Layer.merge(
				Layer.succeed(SyncNetworkService, service),
				Layer.succeed(SyncNetworkServiceTestHelpers, testHelpers)
			)
		})
	)
