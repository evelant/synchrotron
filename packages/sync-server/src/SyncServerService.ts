import { KeyValueStore } from "@effect/platform"
import { SqlSchema } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { ActionModifiedRowRepo } from "@synchrotron/sync-core/ActionModifiedRowRepo"
import { ActionRecordRepo } from "@synchrotron/sync-core/ActionRecordRepo"
import { ClockService } from "@synchrotron/sync-core/ClockService"
import type { HLC } from "@synchrotron/sync-core/HLC"
import { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"
import { Cause, Data, Effect, Schema } from "effect"

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

		const findActionsSince = SqlSchema.findAll({
			Request: Schema.Struct({
				clientId: Schema.String,
				sinceServerIngestId: Schema.Number
			}),
			Result: ActionRecord,
			execute: ({ clientId, sinceServerIngestId }) => {
				const whereClauses = [
					sql`client_id != ${clientId}`,
					sql`server_ingest_id > ${sinceServerIngestId}`
				]

				return sql`
						SELECT * FROM action_records
						${whereClauses.length > 0 ? sql`WHERE ${sql.and(whereClauses)}` : sql``}
						ORDER BY server_ingest_id ASC, id ASC
					`
			}
		})

		const findModifiedRowsForActions = SqlSchema.findAll({
			Request: Schema.Array(Schema.String),
			Result: ActionModifiedRow,
			execute: (actionIds) => sql`
				SELECT * FROM action_modified_rows
				WHERE action_record_id IN ${sql.in(actionIds)}
				ORDER BY action_record_id, sequence ASC
			`
		})

		/**
		 * Receives actions from a client, performs conflict checks, handles rollbacks,
		 * inserts data, and applies patches to the server state.
		 */
		const receiveActions = (
			clientId: string,
			actions: readonly ActionRecord[],
			amrs: readonly ActionModifiedRow[]
			) =>
				Effect.gen(function* () {
					const sql = yield* PgClient.PgClient
					const actionTags = actions.reduce<Record<string, number>>((acc, action) => {
						acc[action._tag] = (acc[action._tag] ?? 0) + 1
						return acc
					}, {})
					const hasSyncDelta = actions.some((a) => a._tag === "_InternalSyncApply")

					yield* Effect.logInfo("server.receiveActions.start", {
						clientId,
						actionCount: actions.length,
						amrCount: amrs.length,
						actionTags,
						hasSyncDelta
					})
					if (actions.length === 0) {
						yield* Effect.logDebug("server.receiveActions.noop", { clientId })
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

						yield* Effect.logDebug("server.receiveActions.conflictCheck.start", {
							clientId,
							latestIncomingClock,
							affectedRowCount: affectedRowKeys.length,
							affectedRowPreview: affectedRowKeys.slice(0, 20)
						})

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
							ORDER BY ar.clock_time_ms ASC, ar.clock_counter ASC, ar.client_id ASC, ar.id ASC
						`.pipe(
						Effect.mapError(
							(e) => new ServerInternalError({ message: "Conflict check query failed", cause: e })
						)
					)

						if (conflictingServerActions.length > 0) {
							yield* Effect.logWarning("server.receiveActions.conflictCheck.conflict", {
								clientId,
								conflictCount: conflictingServerActions.length,
								conflictingActions: conflictingServerActions.slice(0, 25).map((a) => ({
									id: a.id,
									_tag: a._tag,
									client_id: a.client_id,
									clock: a.clock,
									server_ingest_id: a.server_ingest_id
								}))
							})
							return yield* Effect.fail(
								new ServerConflictError({
									message: `Conflict detected: ${conflictingServerActions.length} newer server actions affect the same rows. Client must reconcile.`,
									conflictingActions: conflictingServerActions
								})
							)
						}
						yield* Effect.logDebug("server.receiveActions.conflictCheck.ok", { clientId })
					}

					yield* Effect.gen(function* () {
						const incomingRollbacks = actions.filter((a) => a._tag === "RollbackAction")
						if (incomingRollbacks.length > 0) {
							yield* Effect.logInfo("server.receiveActions.rollback.detected", {
								clientId,
								rollbackCount: incomingRollbacks.length
							})
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
										yield* Effect.logInfo("server.receiveActions.rollback.apply", {
											clientId,
											targetActionId: oldestTargetAction.id
										})
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
								INSERT INTO action_records (server_ingest_id, id, client_id, _tag, args, clock, synced, transaction_id, created_at)
								VALUES (
									nextval('action_records_server_ingest_id_seq'),
									${actionRecord.id},
									${actionRecord.client_id},
									${actionRecord._tag},
									${sql.json(actionRecord.args)},
									${sql.json(actionRecord.clock)},
									1,
									${actionRecord.transaction_id},
									${new Date(actionRecord.created_at).toISOString()}
								)
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

							yield* Effect.logDebug("server.receiveActions.applyForward.start", {
								clientId,
								amrCount: sortedAmrIdsToApply.length,
								amrIdsPreview: sortedAmrIdsToApply.slice(0, 50)
							})

							yield* Effect.acquireUseRelease(
								sql`SELECT set_config('sync.disable_trigger', 'true', true)`,
								() => sql`SELECT apply_forward_amr_batch(${sql.array(sortedAmrIdsToApply)})`,
								() =>
									sql`SELECT set_config('sync.disable_trigger', 'false', true)`.pipe(
										Effect.catchAll(Effect.logError)
									)
							).pipe(
								sql.withTransaction,
								Effect.tapErrorCause((cause) =>
									Effect.logError("server.receiveActions.applyForward.error", {
										clientId,
										amrCount: sortedAmrIdsToApply.length,
										amrIdsPreview: sortedAmrIdsToApply.slice(0, 50),
										cause: Cause.pretty(cause)
									})
								),
								Effect.withSpan("SyncServerService.applyForwardPatches", {
									attributes: { clientId, amrCount: sortedAmrIdsToApply.length }
								})
							)
						} else {
							yield* Effect.logDebug("server.receiveActions.applyForward.noop", { clientId })
						}
					}
				}).pipe(
					Effect.mapError(
						(e) =>
							new ServerInternalError({
								message: "Transaction failed during receiveActions",
								cause: e
							})
					)
				)

					yield* Effect.logInfo("server.receiveActions.success", {
						clientId,
						actionCount: actions.length,
						amrCount: amrs.length,
						actionTags
					})
				}).pipe(
				sql.withTransaction,
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
					Effect.annotateLogs({ serverOperation: "receiveActions", requestingClientId: clientId }),
					Effect.withSpan("SyncServerService.receiveActions", {
						attributes: { clientId, actionCount: actions.length, amrCount: amrs.length }
					})
				)

			const getActionsSince = (clientId: string, sinceServerIngestId: number) =>
				Effect.gen(function* () {
					const sql = yield* PgClient.PgClient
					yield* Effect.logDebug("server.getActionsSince.start", { clientId, sinceServerIngestId })
					const actions = yield* findActionsSince({ clientId, sinceServerIngestId }).pipe(
						Effect.mapError(
							(error) =>
								new ServerInternalError({
								message: `Database error fetching actions: ${error.message}`,
								cause: error
							})
					)
				)

				yield* Effect.logDebug("server.getActionsSince.actions", {
					clientId,
					sinceServerIngestId,
					actionCount: actions.length
				})

				let modifiedRows: readonly ActionModifiedRow[] = []
				if (actions.length > 0) {
					const actionIds = actions.map((a: ActionRecord) => a.id)
					modifiedRows = yield* findModifiedRowsForActions(actionIds).pipe(
						Effect.mapError(
							(error) =>
								new ServerInternalError({
									message: `Database error fetching modified rows: ${error.message}`,
									cause: error
								})
						)
					)
					yield* Effect.logDebug("server.getActionsSince.modifiedRows", {
						clientId,
						actionCount: actions.length,
						amrCount: modifiedRows.length
					})
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
				Effect.annotateLogs({ serverOperation: "getActionsSince", requestingClientId: clientId }),
				Effect.withSpan("SyncServerService.getActionsSince", {
					attributes: { clientId, sinceServerIngestId }
				}),
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
	dependencies: [ClockService.Default, ActionRecordRepo.Default, ActionModifiedRowRepo.Default]
}) {}
