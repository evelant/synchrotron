/**
 * Loads local pending (unsynced) actions for `rebase`, and buckets CORRECTION AMRs by action ID.
 *
 * Rebase preserves unsynced actions across a snapshot-reset by replaying them after the snapshot
 * is applied. CORRECTION actions are special because their effects are represented as AMRs.
 */
import { Effect } from "effect"
import type { ActionModifiedRowRepo } from "../ActionModifiedRowRepo"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ActionModifiedRow, ActionRecord } from "../models"
import { CorrectionActionTag } from "../SyncActionTags"

export const loadRebasePendingActions = (deps: {
	readonly actionRecordRepo: ActionRecordRepo
	readonly actionModifiedRowRepo: ActionModifiedRowRepo
}) =>
	Effect.gen(function* () {
		const { actionRecordRepo, actionModifiedRowRepo } = deps

		const pendingActions = yield* actionRecordRepo.allUnsyncedActive()

		const pendingCorrectionActionIds = pendingActions
			.filter((a) => a._tag === CorrectionActionTag)
			.map((a) => a.id)

		const pendingCorrectionAmrs =
			pendingCorrectionActionIds.length === 0
				? ([] as const)
				: yield* actionModifiedRowRepo.findByActionRecordIds(pendingCorrectionActionIds)

		const pendingCorrectionAmrsByActionId = new Map<string, readonly ActionModifiedRow[]>()
		{
			const buckets = new Map<string, ActionModifiedRow[]>()
			for (const amr of pendingCorrectionAmrs) {
				const existing = buckets.get(amr.action_record_id) ?? []
				existing.push(amr)
				buckets.set(amr.action_record_id, existing)
			}
			for (const [actionId, rows] of buckets) {
				pendingCorrectionAmrsByActionId.set(actionId, rows)
			}
		}

		return {
			pendingActions: pendingActions as readonly ActionRecord[],
			pendingCorrectionActionIds,
			pendingCorrectionAmrs,
			pendingCorrectionAmrsByActionId
		} as const
	})
