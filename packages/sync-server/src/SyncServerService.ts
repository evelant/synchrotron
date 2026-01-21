import { KeyValueStore } from "@effect/platform"
import { SqlClient, SqlSchema } from "@effect/sql"
import { ActionModifiedRowRepo } from "@synchrotron/sync-core/ActionModifiedRowRepo"
import { ActionRecordRepo } from "@synchrotron/sync-core/ActionRecordRepo"
import { ClockService } from "@synchrotron/sync-core/ClockService"
import type { HLC } from "@synchrotron/sync-core/HLC"
import { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"
import { Cause, Data, Effect, Option, Schema } from "effect"
import { SyncSnapshotConfig } from "./SyncSnapshotConfig"
import { SyncUserId } from "./SyncUserId"

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

export interface BootstrapSnapshotResult {
	readonly serverIngestId: number
	readonly serverClock: HLC
	readonly tables: ReadonlyArray<{
		readonly tableName: string
		readonly rows: ReadonlyArray<Record<string, unknown>>
	}>
}

export class SyncServerService extends Effect.Service<SyncServerService>()("SyncServerService", {
	effect: Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
			const clockService = yield* ClockService
			const actionRecordRepo = yield* ActionRecordRepo
			const actionModifiedRowRepo = yield* ActionModifiedRowRepo
			const keyValueStore = yield* KeyValueStore.KeyValueStore

		const toNumber = (value: unknown): number => {
			if (typeof value === "number") return value
			if (typeof value === "bigint") return Number(value)
			if (typeof value === "string") return Number(value)
			return Number(value)
		}

		const parseJson = (value: unknown): unknown => {
			if (typeof value !== "string") return value
			try {
				return JSON.parse(value)
			} catch {
				return value
			}
		}

		const parseClock = (value: unknown): HLC => {
			const parsed = parseJson(value)
			if (typeof parsed === "object" && parsed !== null) {
				const obj = parsed as { readonly timestamp?: unknown; readonly vector?: unknown }
				return {
					timestamp: typeof obj.timestamp === "number" ? obj.timestamp : Number(obj.timestamp ?? 0),
					vector: typeof obj.vector === "object" && obj.vector !== null ? (obj.vector as any) : {}
				}
			}
			return { timestamp: 0, vector: {} }
		}

		const findActionsSince = SqlSchema.findAll({
			Request: Schema.Struct({
				clientId: Schema.String,
				sinceServerIngestId: Schema.Number,
				includeSelf: Schema.optional(Schema.Boolean)
			}),
			Result: ActionRecord,
			execute: ({ clientId, sinceServerIngestId, includeSelf }) => {
				const whereClauses = [
					sql`server_ingest_id > ${sinceServerIngestId}`
				]
				if (includeSelf !== true) {
					whereClauses.unshift(sql`client_id != ${clientId}`)
				}

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
			basisServerIngestId: number,
			actions: readonly ActionRecord[],
			amrs: readonly ActionModifiedRow[]
		) =>
			Effect.gen(function* () {
				const userId = yield* SyncUserId
				// Set the RLS context for the duration of this transaction.
				yield* sql`SELECT set_config('synchrotron.user_id', ${userId}, true)`
				yield* sql`SELECT set_config('request.jwt.claim.sub', ${userId}, true)`

				const actionTags = actions.reduce<Record<string, number>>((acc, action) => {
					acc[action._tag] = (acc[action._tag] ?? 0) + 1
					return acc
				}, {})
				const hasSyncDelta = actions.some((a) => a._tag === "_InternalSyncApply")

				yield* Effect.logInfo("server.receiveActions.start", {
					userId,
					clientId,
					basisServerIngestId,
					actionCount: actions.length,
					amrCount: amrs.length,
					actionTags,
					hasSyncDelta
				})

				if (actions.length === 0) {
					yield* Effect.logDebug("server.receiveActions.noop", { clientId })
					return
				}

				const invalidClientIdActions = actions.filter((a) => a.client_id !== clientId)
				if (invalidClientIdActions.length > 0) {
					yield* Effect.logWarning("server.receiveActions.invalidClientId", {
						clientId,
						invalidActionCount: invalidClientIdActions.length,
						invalidActionIds: invalidClientIdActions.slice(0, 20).map((a) => a.id),
						invalidActionClientIds: Array.from(
							new Set(invalidClientIdActions.slice(0, 50).map((a) => a.client_id))
						)
					})
					return yield* Effect.fail(
						new ServerInternalError({
							message: `Invalid upload: all actions must have client_id=${clientId}`
						})
					)
				}

				const actionIdSet = new Set(actions.map((a) => a.id))
				const invalidAmrs = amrs.filter((amr) => actionIdSet.has(amr.action_record_id) === false)
				if (invalidAmrs.length > 0) {
					yield* Effect.logWarning("server.receiveActions.invalidAmrBatch", {
						clientId,
						invalidAmrCount: invalidAmrs.length,
						invalidAmrIds: invalidAmrs.slice(0, 20).map((a) => a.id),
						invalidAmrActionRecordIds: Array.from(
							new Set(invalidAmrs.slice(0, 50).map((a) => a.action_record_id))
						)
					})
					return yield* Effect.fail(
						new ServerInternalError({
							message: "Invalid upload: AMRs must reference actions in the same batch"
						})
					)
				}

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

				const toJsonbString = (value: unknown): string =>
					typeof value === "string" ? value : JSON.stringify(value)

				const compareReplayKey = (a: ReplayKey, b: ReplayKey): number => {
					if (a.timeMs !== b.timeMs) return a.timeMs < b.timeMs ? -1 : 1
					if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1
					if (a.clientId !== b.clientId) return a.clientId < b.clientId ? -1 : 1
					if (a.id !== b.id) return a.id < b.id ? -1 : 1
					return 0
				}

				const replayKeyForAction = (action: ActionRecord): ReplayKey => {
					const counter = toNumber(action.clock.vector?.[action.client_id] ?? 0)
					return {
						timeMs: toNumber(action.clock.timestamp ?? 0),
						counter,
						clientId: action.client_id,
						id: action.id
					}
				}

				// Simplified correctness gate: only accept uploads from clients that are at the current
				// server ingestion head for actions visible to them (excluding their own).
				//
				// This is intentionally coarse (global), assuming honest clients:
				// - If the client is behind, it must fetch remote actions, reconcile locally, then retry.
				// - Late-arriving actions by HLC are still accepted; the server re-materializes via rollback+replay.
				const unseen = yield* sql<{ readonly id: string; readonly server_ingest_id: number | string }>`
					SELECT id, server_ingest_id
					FROM action_records
					WHERE client_id != ${clientId}
					AND server_ingest_id > ${basisServerIngestId}
					ORDER BY server_ingest_id ASC, id ASC
					LIMIT 1
				`.pipe(
					Effect.mapError(
						(e) =>
							new ServerInternalError({
								message: "Head check query failed",
								cause: e
							})
					)
				)
				if (unseen.length > 0) {
					const first = unseen[0]
					yield* Effect.logWarning("server.receiveActions.behindHead", {
						clientId,
						basisServerIngestId,
						firstUnseenActionId: first?.id ?? null,
						firstUnseenServerIngestId: first ? toNumber(first.server_ingest_id) : null
					})
					return yield* Effect.fail(
						new ServerConflictError({
							message:
								"Client is behind the server ingestion head. Fetch remote actions, reconcile locally, then retry upload.",
							conflictingActions: []
						})
					)
				}
				yield* Effect.logDebug("server.receiveActions.headOk", { clientId, basisServerIngestId })

				// From here on, we need to be able to write and read the sync log regardless of the
				// requesting user's current audience membership (membership churn + late arrival).
				// Sync-table RLS policies should allow a bypass when this flag is set.
				yield* sql`SELECT set_config('synchrotron.internal_materializer', 'true', true)`

				// Insert ActionRecords and AMRs idempotently.
				for (const actionRecord of actions) {
					const argsJson = toJsonbString(actionRecord.args)
					const clockJson = toJsonbString(actionRecord.clock)
					yield* sql`
						INSERT INTO action_records (
							server_ingest_id,
							id,
							user_id,
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
							${userId},
							${actionRecord.client_id},
							${actionRecord._tag},
							${argsJson}::jsonb,
							${clockJson}::jsonb,
							1,
							${actionRecord.transaction_id},
							${new Date(actionRecord.created_at).toISOString()}
						)
						ON CONFLICT (id) DO NOTHING
					`
				}

				for (const modifiedRow of amrs) {
					const forwardJson = toJsonbString(modifiedRow.forward_patches)
					const reverseJson = toJsonbString(modifiedRow.reverse_patches)
					yield* sql`
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
							${forwardJson}::jsonb,
							${reverseJson}::jsonb,
							${modifiedRow.sequence}
						)
						ON CONFLICT (id) DO NOTHING
					`
				}

				const incomingRollbacks = actions.filter((a) => a._tag === "RollbackAction")
				let forcedRollbackTarget: string | null | undefined = undefined
				if (incomingRollbacks.length > 0) {
					const targets = incomingRollbacks.map((rb) => rb.args["target_action_id"] as string | null)
					const hasGenesis = targets.some((t) => t === null)
					if (hasGenesis) {
						forcedRollbackTarget = null
					} else {
						const targetIds = targets.filter((t): t is string => typeof t === "string" && t.length > 0)
						if (targetIds.length > 0) {
							const targetRows = yield* sql<{
								readonly id: string
								readonly clock_time_ms: number | string
								readonly clock_counter: number | string
								readonly client_id: string
							}>`
								SELECT id, clock_time_ms, clock_counter, client_id
								FROM action_records
								WHERE id IN ${sql.in(targetIds)}
							`
							if (targetRows.length !== targetIds.length) {
								return yield* Effect.fail(
									new ServerInternalError({
										message: "Rollback target action(s) not found on server"
									})
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
						sql<{
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
						sql<{
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
						sql<{ readonly id: string }>`
							SELECT id
							FROM action_records
							WHERE (clock_time_ms, clock_counter, client_id, id) < (${key.timeMs}, ${key.counter}, ${key.clientId}, ${key.id})
							ORDER BY clock_time_ms DESC, clock_counter DESC, client_id DESC, id DESC
							LIMIT 1
						`.pipe(Effect.map((rows) => rows[0]?.id ?? null))

					const applyAllUnapplied = () =>
						Effect.acquireUseRelease(
							sql`SELECT set_config('sync.disable_trigger', 'true', true)`,
							() =>
								Effect.gen(function* () {
									const unappliedActions = yield* sql<{
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

									yield* Effect.logInfo("server.materialize.applyUnapplied.start", {
										actionCount: unappliedActions.length,
										firstActionId: unappliedActions[0]?.id ?? null,
										lastActionId: unappliedActions[unappliedActions.length - 1]?.id ?? null
									})

									let appliedActionCount = 0
									let appliedAmrCount = 0

									for (const actionRow of unappliedActions) {
										const actionId = actionRow.id
										const amrIds = yield* sql<{ readonly id: string }>`
											SELECT id
											FROM action_modified_rows
											WHERE action_record_id = ${actionId}
											ORDER BY sequence ASC, id ASC
										`.pipe(Effect.map((rows) => rows.map((r) => r.id)))

										if (amrIds.length === 0) {
											yield* sql`INSERT INTO local_applied_action_ids (action_record_id) VALUES (${actionId}) ON CONFLICT DO NOTHING`
											appliedActionCount += 1
											continue
										}

										for (const amrId of amrIds) {
											yield* sql`SELECT apply_forward_amr(${amrId})`
										}
										yield* sql`INSERT INTO local_applied_action_ids (action_record_id) VALUES (${actionId}) ON CONFLICT DO NOTHING`
										appliedActionCount += 1
										appliedAmrCount += amrIds.length
									}

									yield* Effect.logInfo("server.materialize.applyUnapplied.done", {
										appliedActionCount,
										appliedAmrCount
									})
								}),
							() =>
								sql`SELECT set_config('sync.disable_trigger', 'false', true)`.pipe(
									Effect.catchAll(Effect.logError)
								)
						)

					const materialize = (initialRollbackTarget: string | null | undefined) =>
						Effect.gen(function* () {
							yield* Effect.logInfo("server.materialize.start", {
								forcedRollbackTarget: initialRollbackTarget ?? null
							})
							if (initialRollbackTarget !== undefined) {
								yield* Effect.logInfo("server.materialize.forcedRollback", {
									targetActionId: initialRollbackTarget ?? null
								})
								yield* sql`SELECT rollback_to_action(${initialRollbackTarget})`
							}

							// Loop to handle late-arriving actions that belong before the already-applied frontier.
							while (true) {
								const earliest = yield* getEarliestUnappliedWithPatches()
								if (!earliest) return
								const latestApplied = yield* getLatestApplied()
								if (!latestApplied) {
									yield* Effect.logInfo("server.materialize.noFrontier.applyAll", {
										earliestUnappliedActionId: earliest.id
									})
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
									yield* Effect.logInfo("server.materialize.fastForward", {
										earliestUnappliedActionId: earliest.id,
										latestAppliedActionId: latestApplied.id
									})
									yield* applyAllUnapplied()
									return
								}

								const predecessorId = yield* findPredecessorId(earliestKey)
								yield* Effect.logInfo("server.materialize.rewind", {
									earliestUnappliedActionId: earliest.id,
									latestAppliedActionId: latestApplied.id,
									rollbackTargetActionId: predecessorId
								})
								yield* sql`SELECT rollback_to_action(${predecessorId})`
							}
						})

					yield* materialize(forcedRollbackTarget)

				yield* Effect.logInfo("server.receiveActions.success", {
					userId,
					clientId,
					actionCount: actions.length,
					amrCount: amrs.length,
					actionTags
				})
			}).pipe(
					sql.withTransaction,
					Effect.catchAll((error) => {
						if (error instanceof ServerConflictError || error instanceof ServerInternalError) {
							return Effect.fail(error)
						}

						const unknownError = error as unknown
						const message =
							unknownError instanceof Error ? unknownError.message : String(unknownError)
						return Effect.fail(
							new ServerInternalError({
								message: `Unexpected error during receiveActions: ${message}`,
								cause: unknownError
							})
						)
					}),
					Effect.annotateLogs({ serverOperation: "receiveActions", requestingClientId: clientId }),
					Effect.withSpan("SyncServerService.receiveActions", {
						attributes: { clientId, actionCount: actions.length, amrCount: amrs.length }
					})
			)

		const getActionsSince = (
			clientId: string,
			sinceServerIngestId: number,
			includeSelf: boolean = false
		) =>
				Effect.gen(function* () {
					const userId = yield* SyncUserId
					// Set the RLS context for the duration of this transaction.
					yield* sql`SELECT set_config('synchrotron.user_id', ${userId}, true)`
					yield* sql`SELECT set_config('request.jwt.claim.sub', ${userId}, true)`
					yield* Effect.logDebug("server.getActionsSince.start", {
						userId,
						clientId,
						sinceServerIngestId,
						includeSelf
					})
					const actions = yield* findActionsSince({
						clientId,
						sinceServerIngestId,
						includeSelf
					}).pipe(
						Effect.mapError(
							(error) =>
								new ServerInternalError({
									message: `Database error fetching actions: ${error.message}`,
									cause: error
								})
						)
					)

					yield* Effect.logDebug("server.getActionsSince.actions", {
						userId,
						clientId,
						sinceServerIngestId,
						includeSelf,
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
							userId,
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
					sql.withTransaction,
					Effect.annotateLogs({ serverOperation: "getActionsSince", requestingClientId: clientId }),
					Effect.withSpan("SyncServerService.getActionsSince", {
						attributes: { clientId, sinceServerIngestId, includeSelf }
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

			const getBootstrapSnapshot = (clientId: string) =>
				Effect.gen(function* () {
					const userId = yield* SyncUserId
					yield* sql`SELECT set_config('synchrotron.user_id', ${userId}, true)`
					yield* sql`SELECT set_config('request.jwt.claim.sub', ${userId}, true)`

					const snapshotConfigOption = yield* Effect.serviceOption(SyncSnapshotConfig)
					const snapshotConfig = Option.getOrElse(snapshotConfigOption, () => ({ tables: [] as const }))
					if (snapshotConfig.tables.length === 0) {
						return yield* Effect.fail(
							new ServerInternalError({
								message:
								"Bootstrap snapshot is not configured (SyncSnapshotConfig.tables is empty)"
						})
					)
				}

				const headRow = yield* sql<{
					readonly max_server_ingest_id: number | string | bigint | null
				}>`
					SELECT COALESCE(MAX(server_ingest_id), 0) AS max_server_ingest_id
					FROM action_records
				`
				const serverIngestId = toNumber(headRow[0]?.max_server_ingest_id ?? 0)

				const clockRows = yield* sql<{ readonly clock: unknown }>`
					SELECT clock
					FROM action_records
					ORDER BY clock_time_ms DESC, clock_counter DESC, client_id DESC, id DESC
					LIMIT 1
				`
				const serverClock = parseClock(clockRows[0]?.clock)

				const tables = yield* Effect.forEach(
					snapshotConfig.tables,
					(tableName) =>
						Effect.gen(function* () {
							const rows = yield* sql<Record<string, unknown>>`
								SELECT *
								FROM ${sql(tableName)}
								ORDER BY id ASC
							`
							return { tableName, rows } as const
						}),
					{ concurrency: 1 }
				)

				yield* Effect.logInfo("server.getBootstrapSnapshot.done", {
					userId,
					clientId,
					serverIngestId,
					tableCount: tables.length,
					rowCounts: tables.map((t) => ({ tableName: t.tableName, rowCount: t.rows.length }))
				})

				return { serverIngestId, serverClock, tables } satisfies BootstrapSnapshotResult
			}).pipe(
				sql.withTransaction,
				Effect.annotateLogs({ serverOperation: "getBootstrapSnapshot", requestingClientId: clientId }),
				Effect.withSpan("SyncServerService.getBootstrapSnapshot", {
					attributes: { clientId }
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
							message: `Unexpected error during getBootstrapSnapshot: ${message}`,
							cause: unknownError
						})
					)
				})
			)

		return {
			receiveActions,
			getActionsSince,
			getBootstrapSnapshot
		}
	}),
	dependencies: [ClockService.Default, ActionRecordRepo.Default, ActionModifiedRowRepo.Default]
}) {}
