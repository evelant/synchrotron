import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { ActionModifiedRowRepo } from "../ActionModifiedRowRepo"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ActionRegistry } from "../ActionRegistry"
import type { ClientDbAdapterService } from "../ClientDbAdapter"
import type { DeterministicId } from "../DeterministicId"
import type { ActionRecord } from "../models"
import { applyForwardAmrs } from "../PatchApplier"
import { CorrectionActionTag, RollbackActionTag } from "../SyncActionTags"
import { SyncError } from "../SyncServiceErrors"

export const makeRemoteActionApplier = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly clientDbAdapter: ClientDbAdapterService
	readonly actionRecordRepo: ActionRecordRepo
	readonly actionModifiedRowRepo: ActionModifiedRowRepo
	readonly actionRegistry: ActionRegistry
	readonly deterministicId: DeterministicId
}) => {
	const {
		sqlClient,
		clientDbAdapter,
		actionRecordRepo,
		actionModifiedRowRepo,
		actionRegistry,
		deterministicId
	} = deps

	const applyOneRemoteAction = (actionRecord: ActionRecord) =>
		Effect.gen(function* () {
			if (actionRecord._tag === RollbackActionTag) {
				yield* Effect.logTrace(
					`Skipping RollbackAction during applyActionRecords (re-materialization is handled at the sync strategy level): ${actionRecord.id}`
				)
				yield* actionRecordRepo.markLocallyApplied(actionRecord.id)
				return
			}

			const actionCreator = actionRegistry.getActionCreator(actionRecord._tag)

			if (actionRecord._tag === CorrectionActionTag) {
				yield* Effect.logDebug("applyActionRecords.applyReceivedCorrectionPatches", {
					receivedCorrectionActionId: actionRecord.id
				})
				const correctionAmrs = yield* actionModifiedRowRepo.findByActionRecordIds([actionRecord.id])
				if (correctionAmrs.length > 0) {
					yield* clientDbAdapter.withPatchTrackingDisabled(
						applyForwardAmrs(correctionAmrs).pipe(
							Effect.provideService(SqlClient.SqlClient, sqlClient)
						)
					)
					yield* Effect.logDebug(
						`Applied forward patches for ${correctionAmrs.length} AMRs associated with received CORRECTION action ${actionRecord.id}`
					)
				} else {
					yield* Effect.logWarning(
						`Received CORRECTION action ${actionRecord.id} had no associated ActionModifiedRows.`
					)
				}
			} else if (!actionCreator) {
				return yield* Effect.fail(
					new SyncError({ message: `Missing action creator: ${actionRecord._tag}` })
				)
			} else {
				yield* Effect.logDebug("applyActionRecords.applyRemoteAction", {
					remoteActionId: actionRecord.id,
					remoteActionTag: actionRecord._tag,
					args: actionRecord.args
				})

				yield* deterministicId.withActionContext(
					actionRecord.id,
					actionCreator(actionRecord.args).execute()
				)
			}

			yield* actionRecordRepo.markLocallyApplied(actionRecord.id)
			yield* Effect.logDebug(`Marked remote action ${actionRecord.id} as applied locally.`)
		}).pipe(
			Effect.annotateLogs({
				remoteActionId: actionRecord.id,
				remoteActionTag: actionRecord._tag
			}),
			Effect.withSpan("SyncService.applyActionRecords.applyOneRemoteAction", {
				attributes: {
					remoteActionId: actionRecord.id,
					remoteActionTag: actionRecord._tag
				}
			})
		)

	return { applyOneRemoteAction } as const
}
