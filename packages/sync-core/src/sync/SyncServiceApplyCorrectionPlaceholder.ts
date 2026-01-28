import type { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { ActionModifiedRowRepo } from "../ActionModifiedRowRepo"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ClientClockState } from "../ClientClockState"
import type { ClientDbAdapterService } from "../ClientDbAdapter"
import { ActionRecord } from "../models"
import { bindJsonParam } from "../SqlJson"
import { CorrectionActionTag } from "../SyncActionTags"

type RowKey = { table_name: string; row_id: string }

export const makeCorrectionPlaceholderManager = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly clientDbAdapter: ClientDbAdapterService
	readonly clockState: ClientClockState
	readonly actionRecordRepo: ActionRecordRepo
	readonly actionModifiedRowRepo: ActionModifiedRowRepo
	readonly clientId: string
}) => {
	const {
		sqlClient,
		clientDbAdapter,
		clockState,
		actionRecordRepo,
		actionModifiedRowRepo,
		clientId
	} = deps

	const createCorrectionPlaceholder = (appliedActionIds: readonly string[]) =>
		Effect.gen(function* () {
			// Use an application-level transaction identifier for the batch.
			const transactionId = Date.now()

			// Create ONE placeholder CORRECTION ActionRecord for the batch
			const correctionActionArgs = {
				appliedActionIds,
				timestamp: 0 // Add placeholder timestamp for internal action
			}
			const currentClock = yield* clockState.getCurrentClock // Use clock before potential increments
			const correctionRecord = yield* actionRecordRepo.insert(
				ActionRecord.insert.make({
					id: crypto.randomUUID(),
					client_id: clientId,
					clock: currentClock, // Use current clock initially
					_tag: CorrectionActionTag,
					args: correctionActionArgs,
					created_at: new Date(),
					synced: false, // Placeholder is initially local
					transaction_id: transactionId
				})
			)
			yield* clientDbAdapter.setCaptureContext(correctionRecord.id)
			return correctionRecord
		})

	const finalizeCorrectionPlaceholder = (args: {
		readonly correctionRecordId: string
		readonly hasCorrectionDelta: boolean
		readonly coveredRowKeys: readonly RowKey[]
	}) =>
		Effect.gen(function* () {
			const { correctionRecordId, hasCorrectionDelta, coveredRowKeys } = args

			if (!hasCorrectionDelta) {
				yield* Effect.logInfo(
					"No outgoing CORRECTION delta remains after accounting for received patches (base + CORRECTION). Deleting placeholder CORRECTION action."
				)
				yield* actionModifiedRowRepo.deleteByActionRecordIds(correctionRecordId)
				yield* actionRecordRepo.deleteById(correctionRecordId)
				return
			}

			yield* Effect.logWarning(
				"Overall divergence detected. Keeping placeholder CORRECTION action."
			)

			// Prune any generated patches that are already covered by received patches (base + CORRECTION).
			for (const { table_name, row_id } of coveredRowKeys) {
				yield* sqlClient`
					DELETE FROM action_modified_rows
					WHERE action_record_id = ${correctionRecordId}
					AND table_name = ${table_name}
					AND row_id = ${row_id}
				`
			}

			const newCorrectionClock = yield* clockState.incrementClock
			yield* Effect.logDebug(
				`Updating placeholder CORRECTION action ${correctionRecordId} clock due to divergence: ${JSON.stringify(newCorrectionClock)}`
			)
			const clockValue = bindJsonParam(sqlClient, newCorrectionClock)
			yield* sqlClient`UPDATE action_records SET clock = ${clockValue} WHERE id = ${correctionRecordId}`
			// The delta patches are already applied locally (they came from replay). Track this so rollbacks are correct.
			yield* actionRecordRepo.markLocallyApplied(correctionRecordId)
		})

	return { createCorrectionPlaceholder, finalizeCorrectionPlaceholder } as const
}
