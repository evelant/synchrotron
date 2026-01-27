import type { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { bindJsonParam } from "@synchrotron/sync-core/SqlJson"
import type { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"
import {
	SendLocalActionsBehindHead,
	SendLocalActionsInternal,
	SendLocalActionsInvalid,
	type SendLocalActionsFailure
} from "@synchrotron/sync-core/SyncNetworkService"
import { Effect } from "effect"
import {
	classifyUploadSqlError,
	hasTag,
	isJsonObject,
	isSendLocalActionsFailure
} from "../SyncServerServiceUtils"
import { SyncUserId } from "../SyncUserId"

export const makeReceiveActions = (deps: { readonly sql: SqlClient.SqlClient }) => {
	const { sql } = deps

	/**
	 * Receives actions from a client, performs conflict checks, handles rollbacks,
	 * inserts data, and applies patches to the server state.
	 */
	const receiveActions = (
		clientId: string,
		basisServerIngestId: number,
		actions: readonly ActionRecord[],
		amrs: readonly ActionModifiedRow[]
	): Effect.Effect<void, SendLocalActionsFailure, SyncUserId> =>
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
					new SendLocalActionsInvalid({
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
					new SendLocalActionsInvalid({
						message: "Invalid upload: AMRs must reference actions in the same batch"
					})
				)
			}

			const invalidClockTypeCount = actions.filter((a) => isJsonObject(a.clock) === false).length
			const invalidArgsTypeCount = actions.filter((a) => isJsonObject(a.args) === false).length
			const invalidPatchTypeCount = amrs.filter(
				(a) =>
					isJsonObject(a.forward_patches) === false || isJsonObject(a.reverse_patches) === false
			).length

			if (invalidClockTypeCount > 0 || invalidArgsTypeCount > 0 || invalidPatchTypeCount > 0) {
				yield* Effect.logWarning("server.receiveActions.invalidJsonTypes", {
					clientId,
					invalidClockTypeCount,
					invalidArgsTypeCount,
					invalidPatchTypeCount
				})
				return yield* Effect.fail(
					new SendLocalActionsInvalid({
						message:
							"Invalid upload: JSON fields must be decoded objects (not strings). Ensure RPC schemas use `.json` and do not double-encode JSON."
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

			const compareReplayKey = (a: ReplayKey, b: ReplayKey): number => {
				if (a.timeMs !== b.timeMs) return a.timeMs < b.timeMs ? -1 : 1
				if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1
				if (a.clientId !== b.clientId) return a.clientId < b.clientId ? -1 : 1
				if (a.id !== b.id) return a.id < b.id ? -1 : 1
				return 0
			}

			// Simplified correctness gate: only accept uploads from clients that are at the current
			// server ingestion head for actions visible to them (excluding their own).
			//
			// This is intentionally coarse (global), assuming honest clients:
			// - If the client is behind, it must fetch remote actions, reconcile locally, then retry.
			// - Late-arriving actions by HLC are still accepted; the server re-materializes via rollback+replay.
			const unseen = yield* sql<{
				readonly id: string
				readonly server_ingest_id: number | string
			}>`
				SELECT id, server_ingest_id
				FROM action_records
				WHERE client_id != ${clientId}
				AND server_ingest_id > ${basisServerIngestId}
				ORDER BY server_ingest_id ASC, id ASC
				LIMIT 1
			`.pipe(Effect.mapError(classifyUploadSqlError))
			if (unseen.length > 0) {
				const first = unseen[0]
				const firstUnseenServerIngestId = first
					? toNumber(first.server_ingest_id)
					: basisServerIngestId
				yield* Effect.logWarning("server.receiveActions.behindHead", {
					clientId,
					basisServerIngestId,
					firstUnseenActionId: first?.id ?? null,
					firstUnseenServerIngestId
				})
				return yield* Effect.fail(
					new SendLocalActionsBehindHead({
						message:
							"Client is behind the server ingestion head. Fetch remote actions, reconcile locally, then retry upload.",
						basisServerIngestId,
						firstUnseenServerIngestId,
						firstUnseenActionId: first?.id ?? undefined
					})
				)
			}
			yield* Effect.logDebug("server.receiveActions.headOk", { clientId, basisServerIngestId })

			// From here on, we need to be able to write and read the sync log regardless of the
			// requesting user's current audience membership (membership churn + late arrival).
			// Sync-table RLS policies should allow a bypass when this flag is set.
			yield* sql`SELECT set_config('synchrotron.internal_materializer', 'true', true)`
			// Allow app schemas to use deferrable FK constraints without being sensitive to the
			// transient ordering of rollback+replay inside a single transaction.
			yield* sql`SET CONSTRAINTS ALL DEFERRED`.raw

			// Insert ActionRecords and AMRs idempotently.
			for (const actionRecord of actions) {
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
						${bindJsonParam(sql, actionRecord.args)},
						${bindJsonParam(sql, actionRecord.clock)},
						1,
						${actionRecord.transaction_id},
						${new Date(actionRecord.created_at).toISOString()}
					)
					ON CONFLICT (id) DO NOTHING
				`.pipe(Effect.mapError(classifyUploadSqlError))
			}

			for (const modifiedRow of amrs) {
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
						${bindJsonParam(sql, modifiedRow.forward_patches)},
						${bindJsonParam(sql, modifiedRow.reverse_patches)},
						${modifiedRow.sequence}
					)
					ON CONFLICT (id) DO NOTHING
				`.pipe(Effect.mapError(classifyUploadSqlError))
			}

			const incomingRollbacks = actions.filter((a) => a._tag === "RollbackAction")
			let forcedRollbackTarget: string | null | undefined = undefined
			if (incomingRollbacks.length > 0) {
				const targets = incomingRollbacks.map((rb) => rb.args["target_action_id"] as string | null)
				const hasGenesis = targets.some((t) => t === null)
				if (hasGenesis) {
					forcedRollbackTarget = null
				} else {
					const targetIds = targets.filter(
						(t): t is string => typeof t === "string" && t.length > 0
					)
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
								new SendLocalActionsInvalid({
									message: "Invalid upload: rollback target action(s) not found on server"
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

							for (const unapplied of unappliedActions) {
								const actionId = unapplied.id
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
				if (isSendLocalActionsFailure(error)) return Effect.fail(error)
				if (hasTag(error, "SqlError")) {
					return Effect.fail(classifyUploadSqlError(error as SqlError))
				}

				const unknownError = error as unknown
				const message = unknownError instanceof Error ? unknownError.message : String(unknownError)
				return Effect.fail(
					new SendLocalActionsInternal({
						message: `Unexpected error during receiveActions: ${message}`
					})
				)
			}),
			Effect.annotateLogs({ serverOperation: "receiveActions", requestingClientId: clientId }),
			Effect.withSpan("SyncServerService.receiveActions", {
				attributes: { clientId, actionCount: actions.length, amrCount: amrs.length }
			})
		)

	return { receiveActions } as const
}
