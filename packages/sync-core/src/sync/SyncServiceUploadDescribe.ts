/**
 * Pure helpers for describing an upload batch for logs/telemetry.
 *
 * Produces:
 * - counts by action tag
 * - AMR counts per action ID
 * - (bounded) preview of CORRECTION AMRs
 */
import type { ActionModifiedRow, ActionRecord } from "../models"
import { CorrectionActionTag } from "../SyncActionTags"

export const describeUploadBatch = (args: {
	readonly actionsToSend: readonly ActionRecord[]
	readonly amrs: readonly ActionModifiedRow[]
	readonly valuePreview: (value: unknown, maxLength?: number) => string
}) => {
	const { actionsToSend, amrs, valuePreview } = args

	const actionTags = actionsToSend.reduce<Record<string, number>>((acc, action) => {
		acc[action._tag] = (acc[action._tag] ?? 0) + 1
		return acc
	}, {})

	const amrCountsByActionRecordId: Record<string, number> = {}
	for (const amr of amrs) {
		amrCountsByActionRecordId[amr.action_record_id] =
			(amrCountsByActionRecordId[amr.action_record_id] ?? 0) + 1
	}

	const correctionActionIds = actionsToSend
		.filter((a) => a._tag === CorrectionActionTag)
		.map((a) => a.id)

	const correctionActionIdSet = new Set(correctionActionIds)
	const correctionAmrPreview = amrs
		.filter((amr) => correctionActionIdSet.has(amr.action_record_id))
		.slice(0, 10)
		.map((amr) => ({
			id: amr.id,
			table_name: amr.table_name,
			row_id: amr.row_id,
			operation: amr.operation,
			forward_patches: valuePreview(amr.forward_patches),
			reverse_patches: valuePreview(amr.reverse_patches)
		}))

	return {
		actionTags,
		amrCountsByActionRecordId,
		correctionActionIds,
		correctionAmrPreview,
		hasCorrectionDelta: correctionActionIds.length > 0
	} as const
}
