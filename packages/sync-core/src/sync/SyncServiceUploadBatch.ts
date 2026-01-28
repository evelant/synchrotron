/**
 * Loads the current upload batch (unsynced active ActionRecords + their AMRs).
 *
 * Keeping this as a helper makes `SyncServiceUpload` easier to scan and keeps the query pairing
 * (actions -> IDs -> AMRs) in one place.
 */
import { Effect } from "effect"
import type { ActionModifiedRowRepo } from "../ActionModifiedRowRepo"
import type { ActionRecordRepo } from "../ActionRecordRepo"

export const makeUploadBatchLoader = (deps: {
	readonly actionRecordRepo: ActionRecordRepo
	readonly actionModifiedRowRepo: ActionModifiedRowRepo
}) => {
	const { actionRecordRepo, actionModifiedRowRepo } = deps

	const loadUploadBatch = () =>
		Effect.gen(function* () {
			const actionsToSend = yield* actionRecordRepo.allUnsyncedActive()
			const actionIdsToSend = actionsToSend.map((a) => a.id)
			const amrs =
				actionIdsToSend.length === 0
					? ([] as const)
					: yield* actionModifiedRowRepo.findByActionRecordIds(actionIdsToSend)
			return { actionsToSend, amrs } as const
		})

	return { loadUploadBatch } as const
}
