import { SqlClient, type SqlError } from "@effect/sql"
import type { ParseResult } from "effect"
import { Effect, Option } from "effect"
import type { ActionModifiedRowRepo } from "../ActionModifiedRowRepo"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ClientDbAdapterService } from "../ClientDbAdapter"
import { compareClock } from "../ClockOrder"
import type { ActionRecord } from "../models"
import { applyReverseAmrs } from "../PatchApplier"
import { SyncError } from "../SyncServiceErrors"

export const makeRollback = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly clientDbAdapter: ClientDbAdapterService
	readonly actionRecordRepo: ActionRecordRepo
	readonly actionModifiedRowRepo: ActionModifiedRowRepo
	readonly clientId: string
}) => {
	const { sqlClient, clientDbAdapter, actionRecordRepo, actionModifiedRowRepo, clientId } = deps

	const findCommonAncestor = (): Effect.Effect<
		Option.Option<ActionRecord>,
		SqlError.SqlError | ParseResult.ParseError
	> =>
		Effect.gen(function* () {
			const compareActionRecords = (a: ActionRecord, b: ActionRecord) =>
				compareClock(
					{ clock: a.clock, clientId: a.client_id, id: a.id },
					{ clock: b.clock, clientId: b.client_id, id: b.id }
				)

			const [allActions, appliedIdsRows, pendingActions] = yield* Effect.all([
				actionRecordRepo.all(),
				sqlClient<{
					action_record_id: string
				}>`SELECT action_record_id FROM local_applied_action_ids`,
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

	const rollbackToAction = (targetActionId: string | null) =>
		Effect.gen(function* () {
			const compareActionRecords = (a: ActionRecord, b: ActionRecord) =>
				compareClock(
					{ clock: a.clock, clientId: a.client_id, id: a.id },
					{ clock: b.clock, clientId: b.client_id, id: b.id }
				)

			const allActions = yield* actionRecordRepo.all()
			const targetAction = targetActionId
				? yield* actionRecordRepo.findById(targetActionId).pipe(
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

			const appliedIdsRows = yield* sqlClient<{
				action_record_id: string
			}>`SELECT action_record_id FROM local_applied_action_ids`
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

	return { findCommonAncestor, rollbackToAction, rollbackToCommonAncestor } as const
}
