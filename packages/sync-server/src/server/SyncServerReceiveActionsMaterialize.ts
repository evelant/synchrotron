/**
 * Server-side materialization logic used by `SyncServerReceiveActions`.
 *
 * The server maintains a materialized view of the action log by:
 * - applying forward AMRs for unapplied actions
 * - rewinding via `rollback_to_action(...)` and replaying forward when late-arriving actions belong
 *   before the current applied frontier (HLC order)
 *
 * This module also derives a "forced rollback target" from uploaded RollbackAction markers, so
 * explicit client-requested rewinds are honored deterministically.
 */
import type { SqlClient } from "@effect/sql"
import {
	actionLogOrderKeyFromRow,
	compareActionLogOrderKey,
	findPredecessorActionId,
	resolveOldestExistingActionId
} from "@synchrotron/sync-core/ActionLogOrder"
import { RollbackActionTag } from "@synchrotron/sync-core/SyncActionTags"
import type { ActionRecord } from "@synchrotron/sync-core/models"
import { SendLocalActionsInvalid } from "@synchrotron/sync-core/SyncNetworkService"
import { Effect } from "effect"

/**
 * If an upload includes RollbackAction markers, derive the "oldest" rollback target action ID.
 *
 * Returns:
 * - `undefined` when no rollbacks are present
 * - `null` to indicate rollback-to-genesis
 * - a concrete action ID to rollback to
 */
export const deriveForcedRollbackTargetFromUpload = (deps: {
	readonly sql: SqlClient.SqlClient
	readonly actions: readonly ActionRecord[]
}) =>
	Effect.gen(function* () {
		const { sql, actions } = deps

		const incomingRollbacks = actions.filter((a) => a._tag === RollbackActionTag)
		if (incomingRollbacks.length === 0) return undefined

		const targets = incomingRollbacks.map((rb) => rb.args["target_action_id"] as string | null)
		const hasGenesis = targets.some((t) => t === null)
		if (hasGenesis) return null

		const targetIds = targets.filter((t): t is string => typeof t === "string" && t.length > 0)
		if (targetIds.length === 0) return undefined

		const { oldestId, missingIds } = yield* resolveOldestExistingActionId({ sql, ids: targetIds })
		if (missingIds.length > 0) {
			return yield* Effect.fail(
				new SendLocalActionsInvalid({
					message: `Invalid upload: rollback target action(s) not found on server: ${missingIds.join(", ")}`
				})
			)
		}
		return oldestId ?? undefined
	})

/**
 * Materializes any unapplied actions on the server, including handling late-arriving actions
 * via rollback+replay. `forcedRollbackTarget` (from uploaded RollbackActions) can force an
 * initial rewind before applying forward.
 */
export const materializeServerActionLog = (deps: {
	readonly sql: SqlClient.SqlClient
	readonly forcedRollbackTarget: string | null | undefined
}) => {
	const { sql, forcedRollbackTarget } = deps

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
				AND ar._tag != ${RollbackActionTag}
				GROUP BY ar.id, ar.clock_time_ms, ar.clock_counter, ar.client_id
				ORDER BY ar.clock_time_ms ASC, ar.clock_counter ASC, ar.client_id ASC, ar.id ASC
				LIMIT 1
			`.pipe(Effect.map((rows) => rows[0] ?? null))

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
							AND ar._tag != ${RollbackActionTag}
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

				const earliestKey = actionLogOrderKeyFromRow(earliest)
				const latestKey = actionLogOrderKeyFromRow(latestApplied)

				if (compareActionLogOrderKey(earliestKey, latestKey) > 0) {
					yield* Effect.logInfo("server.materialize.fastForward", {
						earliestUnappliedActionId: earliest.id,
						latestAppliedActionId: latestApplied.id
					})
					yield* applyAllUnapplied()
					return
				}

				const predecessorId = yield* findPredecessorActionId(sql, earliestKey)
				yield* Effect.logInfo("server.materialize.rewind", {
					earliestUnappliedActionId: earliest.id,
					latestAppliedActionId: latestApplied.id,
					rollbackTargetActionId: predecessorId
				})
				yield* sql`SELECT rollback_to_action(${predecessorId})`
			}
		})

	return materialize(forcedRollbackTarget)
}
