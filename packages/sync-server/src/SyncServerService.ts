import { KeyValueStore } from "@effect/platform"
import { PgClient } from "@effect/sql-pg"
import { ActionModifiedRowRepo } from "@synchrotron/sync-core/ActionModifiedRowRepo"
import { ActionRecordRepo } from "@synchrotron/sync-core/ActionRecordRepo"
import { ClockService } from "@synchrotron/sync-core/ClockService"
import type { HLC } from "@synchrotron/sync-core/HLC"
import type { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"
import { PgClientLive } from "@synchrotron/sync-server/db/connection"
import { Data, Effect } from "effect"

export class ServerConflictError extends Data.TaggedError("ServerConflictError")<{
	readonly message: string
	readonly conflictingActions: readonly ActionRecord[]
}> {}

export class ServerInternalError extends Data.TaggedError("ServerInternalError")<{
	readonly message: string
	readonly cause?: unknown
}> {}

export interface FetchActionsResult {
	readonly actions: readonly ActionRecord[]
	readonly modifiedRows: readonly ActionModifiedRow[]
	readonly serverClock: HLC
}

export class SyncServerService extends Effect.Service<SyncServerService>()("SyncServerService", {
	effect: Effect.gen(function* () {
		const sql = yield* PgClient.PgClient
		const clockService = yield* ClockService
		const actionRecordRepo = yield* ActionRecordRepo
		const actionModifiedRowRepo = yield* ActionModifiedRowRepo
		const keyValueStore = yield* KeyValueStore.KeyValueStore

		/**
		 * Receives actions from a client, performs conflict checks, handles rollbacks,
		 * inserts data, and applies patches to the server state.
		 */
		const receiveActions = (
			clientId: string,
			actions: readonly ActionRecord[],
			amrs: readonly ActionModifiedRow[]
		): Effect.Effect<void, ServerConflictError | ServerInternalError> =>
			Effect.gen(function* () {
				yield* Effect.logInfo(
					`Server: receiveActions called by ${clientId} with ${actions.length} actions.`
				)
				if (actions.length === 0) {
					yield* Effect.logDebug("Server: No incoming actions to process.")
					return
				}

				if (amrs.length > 0) {
					const affectedRowKeys = amrs.map((r) => ({
						table_name: r.table_name,
						row_id: r.row_id
					}))
					const rowConditions = affectedRowKeys.map(
						(key) => sql`(amr.table_name = ${key.table_name} AND amr.row_id = ${key.row_id})`
					)

					const latestAction = actions.reduce(
						(latest, current) => {
							if (!latest) return current
							const latestArg = { clock: latest.clock, clientId: latest.client_id }
							const currentArg = { clock: current.clock, clientId: current.client_id }
							return clockService.compareClock(currentArg, latestArg) > 0 ? current : latest
						},
						null as ActionRecord | null
					)

					const latestIncomingClock = latestAction?.clock
					if (!latestIncomingClock) {
						return yield* Effect.die("Incoming actions must have a clock for conflict check")
					}

					yield* Effect.logDebug(
						`Server: Checking for conflicts newer than ${JSON.stringify(latestIncomingClock)} affecting rows: ${JSON.stringify(affectedRowKeys)}`
					)

					const conflictingServerActions = yield* sql<ActionRecord>`
							WITH conflicting_rows AS (
								SELECT DISTINCT amr.action_record_id
								FROM action_modified_rows amr
								WHERE ${sql.or(rowConditions)}
							)
							SELECT ar.*
							FROM action_records ar
							JOIN conflicting_rows cr ON ar.id = cr.action_record_id
							WHERE compare_hlc(ar.clock, ${sql.json(latestIncomingClock)}) > 0 -- Use sql.json
							ORDER BY sortable_clock ASC
						`.pipe(
						Effect.mapError(
							(e) => new ServerInternalError({ message: "Conflict check query failed", cause: e })
						)
					)

					if (conflictingServerActions.length > 0) {
						yield* Effect.logWarning(
							`Server: Conflict detected for client ${clientId}. ${conflictingServerActions.length} newer server actions affect the same rows.`
						)
						return yield* Effect.fail(
							new ServerConflictError({
								message: `Conflict detected: ${conflictingServerActions.length} newer server actions affect the same rows. Client must reconcile.`,
								conflictingActions: conflictingServerActions
							})
						)
					}
					yield* Effect.logDebug("Server: No conflicts detected.")
				}

				yield* Effect.gen(function* () {
					const incomingRollbacks = actions.filter((a) => a._tag === "RollbackAction")
					if (incomingRollbacks.length > 0) {
						yield* Effect.logInfo(
							`Server: Received ${incomingRollbacks.length} RollbackAction(s) from ${clientId}. Determining oldest target.`
						)
						const targetActionIds = incomingRollbacks.map(
							(rb) => rb.args["target_action_id"] as string
						)

						if (targetActionIds.length > 0 && targetActionIds.every((id) => id)) {
							const targetActions = yield* sql<ActionRecord>`
									SELECT * FROM action_records WHERE id IN ${sql.in(targetActionIds)}
								`

							if (targetActions.length > 0) {
								const sortedTargets = targetActions
									.map((a) => ({ clock: a.clock, clientId: a.client_id, id: a.id }))
									.sort((a, b) => clockService.compareClock(a, b))

								const oldestTargetAction = sortedTargets[0]
								if (oldestTargetAction) {
									yield* Effect.logInfo(
										`Server: Rolling back server state to target action: ${oldestTargetAction.id}`
									)
									yield* sql`SELECT rollback_to_action(${oldestTargetAction.id})`
								} else {
									yield* Effect.logWarning(
										"Server: Could not determine the oldest target action for rollback."
									)
								}
							} else {
								yield* Effect.logWarning(
									`Server: Received RollbackAction(s) but could not find target action(s) with IDs: ${targetActionIds.join(", ")}`
								)
							}
						} else {
							yield* Effect.logWarning(
								`Server: Received RollbackAction(s) from ${clientId} but target_action_id was missing or invalid in args.`
							)
						}
					}

					for (const actionRecord of actions) {
						yield* Effect.logDebug(
							`Server: Inserting action ${actionRecord.id} (${actionRecord._tag}) from client ${clientId}`
						)
						yield* sql`
								INSERT INTO action_records (id, client_id, _tag, args, clock, synced, transaction_id, created_at)
								VALUES (${actionRecord.id}, ${actionRecord.client_id}, ${actionRecord._tag}, ${sql.json(actionRecord.args)}, ${sql.json(actionRecord.clock)}, true, ${actionRecord.transaction_id}, ${new Date(actionRecord.created_at)})
								ON CONFLICT (id) DO NOTHING
              				`
					}

					for (const modifiedRow of amrs) {
						yield* Effect.logTrace(
							`Server: Inserting AMR ${modifiedRow.id} for action ${modifiedRow.action_record_id}`
						)
						yield* sql`
								INSERT INTO action_modified_rows (id, table_name, row_id, action_record_id, operation, forward_patches, reverse_patches, sequence)
								VALUES (${modifiedRow.id}, ${modifiedRow.table_name}, ${modifiedRow.row_id}, ${modifiedRow.action_record_id}, ${modifiedRow.operation}, ${sql.json(modifiedRow.forward_patches)}, ${sql.json(modifiedRow.reverse_patches)}, ${modifiedRow.sequence})
								ON CONFLICT (id) DO NOTHING
              				`
					}

					if (amrs.length > 0) {
						const nonRollbackActions = actions.filter((a) => a._tag !== "RollbackAction")
						const nonRollbackActionIds = nonRollbackActions.map((a) => a.id)

						const amrsToApplyForward = amrs.filter((amr) =>
							nonRollbackActionIds.includes(amr.action_record_id)
						)

						if (amrsToApplyForward.length > 0) {
							const actionMap = new Map(nonRollbackActions.map((action) => [action.id, action]))
							const sortedAmrs = [...amrsToApplyForward].sort((a, b) => {
								const actionA = actionMap.get(a.action_record_id)
								const actionB = actionMap.get(b.action_record_id)
								if (!actionA || !actionB) return 0
								return clockService.compareClock(
									{ clock: actionA.clock, clientId: actionA.client_id },
									{ clock: actionB.clock, clientId: actionB.client_id }
								)
							})
							const sortedAmrIdsToApply = sortedAmrs.map((amr) => amr.id)

							yield* Effect.logDebug(
								`Server: Applying forward patches for ${sortedAmrIdsToApply.length} AMRs in HLC order: [${sortedAmrIdsToApply.join(", ")}]`
							)
							yield* sql`SELECT set_config('sync.disable_trigger', 'true', true)`
							try {
								yield* sql`SELECT apply_forward_amr_batch(${sql.array(sortedAmrIdsToApply)})`
							} finally {
								yield* sql`SELECT set_config('sync.disable_trigger', 'false', true)`
							}
						} else {
							yield* Effect.logDebug(
								"Server: No forward patches to apply after filtering rollbacks."
							)
						}
					}
				}).pipe(
					sql.withTransaction,
					Effect.mapError(
						(e) =>
							new ServerInternalError({
								message: "Transaction failed during receiveActions",
								cause: e
							})
					)
				)

				yield* Effect.logInfo(
					`Server: Successfully processed ${actions.length} actions from client ${clientId}.`
				)
			}).pipe(
				Effect.catchAll((error) => {
					// Check specific error types first
					if (error instanceof ServerConflictError || error instanceof ServerInternalError) {
						return Effect.fail(error)
					}
					// Handle remaining unknown errors
					const unknownError = error as unknown // Cast to unknown
					// Check if it's an Error instance to safely access .message
					const message =
						unknownError instanceof Error ? unknownError.message : String(unknownError)
					return Effect.fail(
						new ServerInternalError({
							message: `Unexpected error during receiveActions: ${message}`,
							cause: unknownError // Keep original error as cause
						})
					)
				}),
				Effect.annotateLogs({ serverOperation: "receiveActions", requestingClientId: clientId })
			)

		const getActionsSince = (
			clientId: string,
			lastSyncedClock: HLC
		): Effect.Effect<FetchActionsResult, ServerInternalError> =>
			Effect.gen(function* () {
				yield* Effect.logDebug(
					`Server: getActionsSince called by ${clientId} with clock ${JSON.stringify(lastSyncedClock)}`
				)
				const isInitialSync = Object.keys(lastSyncedClock.vector).length === 0

				const actions = yield* sql<ActionRecord>`
						SELECT * FROM action_records
						${isInitialSync ? sql`` : sql`WHERE compare_hlc(clock, ${sql.json(lastSyncedClock)}) > 0`}
						ORDER BY sortable_clock ASC
          			`.pipe(
					Effect.mapError(
						(error) =>
							new ServerInternalError({
								message: `Database error fetching actions: ${error.message}`,
								cause: error
							})
					)
				)

				yield* Effect.logDebug(
					`Server: Found ${actions.length} actions newer than client ${clientId}'s clock.`
				)

				let modifiedRows: readonly ActionModifiedRow[] = []
				if (actions.length > 0) {
					const actionIds = actions.map((a: ActionRecord) => a.id)
					modifiedRows = yield* sql<ActionModifiedRow>`
              				SELECT * FROM action_modified_rows
              				WHERE action_record_id IN ${sql.in(actionIds)}
							ORDER BY action_record_id, sequence ASC
            			`.pipe(
						Effect.mapError(
							(error) =>
								new ServerInternalError({
									message: `Database error fetching modified rows: ${error.message}`,
									cause: error
								})
						)
					)
					yield* Effect.logDebug(
						`Server: Found ${modifiedRows.length} modified rows for ${actions.length} actions.`
					)
				}

				const serverClock = yield* clockService.getClientClock.pipe(
					Effect.mapError(
						(error) =>
							new ServerInternalError({
								message: `Failed to get server clock: ${error.message}`,
								cause: error
							})
					)
				)

				return { actions, modifiedRows, serverClock }
			}).pipe(
				Effect.catchAll((error) => {
					const unknownError = error as unknown
					if (unknownError instanceof ServerInternalError) {
						return Effect.fail(unknownError)
					}
					const message =
						unknownError instanceof Error ? unknownError.message : String(unknownError)
					return Effect.fail(
						new ServerInternalError({
							message: `Unexpected error during getActionsSince: ${message}`,
							cause: unknownError
						})
					)
				})
			)

		return {
			receiveActions,
			getActionsSince
		}
	}),
	dependencies: [
		PgClientLive,
		ClockService.Default,
		ActionRecordRepo.Default,
		ActionModifiedRowRepo.Default
	]
}) {}
