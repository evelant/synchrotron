/**
 * Replays pending (unsynced) actions after a snapshot-reset during `rebase`.
 *
 * The replay strategy is:
 * - reinsert ActionRecords with fresh clocks (so they come after the snapshot frontier)
 * - for CORRECTION actions, reinsert AMRs and apply them forward with patch tracking disabled
 * - for RollbackAction, treat as a marker only and mark locally applied
 * - for normal actions, execute deterministically under action-scoped ID generation
 *
 * This runs inside the caller's transaction and assumes the snapshot has already been applied.
 */
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ActionRegistry } from "../ActionRegistry"
import type { ClientClockState } from "../ClientClockState"
import type { ClientDbAdapterService } from "../ClientDbAdapter"
import type { DeterministicId } from "../DeterministicId"
import type { ActionModifiedRow, ActionRecord } from "../models"
import { ActionRecord as ActionRecordModel } from "../models"
import { applyForwardAmrs } from "../PatchApplier"
import { bindJsonParam } from "../SqlJson"
import { CorrectionActionTag, RollbackActionTag } from "../SyncActionTags"
import { SyncError } from "../SyncServiceErrors"

export const makeRebaseReplayer = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly clientDbAdapter: ClientDbAdapterService
	readonly clockState: ClientClockState
	readonly actionRecordRepo: ActionRecordRepo
	readonly actionRegistry: ActionRegistry
	readonly deterministicId: DeterministicId
	readonly clientId: string
}) => {
	const {
		sqlClient,
		clientDbAdapter,
		clockState,
		actionRecordRepo,
		actionRegistry,
		deterministicId,
		clientId
	} = deps

	const replayPendingActions = (
		pendingActions: readonly ActionRecord[],
		pendingCorrectionAmrsByActionId: ReadonlyMap<string, readonly ActionModifiedRow[]>
	) =>
		Effect.gen(function* () {
			for (const pending of pendingActions) {
				const nextClock = yield* clockState.incrementClock

				yield* actionRecordRepo.insert(
					ActionRecordModel.insert.make({
						id: pending.id,
						client_id: clientId,
						clock: nextClock,
						_tag: pending._tag,
						args: pending.args,
						created_at: pending.created_at,
						synced: false,
						transaction_id: pending.transaction_id,
						user_id: pending.user_id ?? null
					})
				)

				if (pending._tag === CorrectionActionTag) {
					const correctionAmrs = pendingCorrectionAmrsByActionId.get(pending.id) ?? []

					for (const amr of correctionAmrs) {
						yield* sqlClient`
							INSERT INTO action_modified_rows ${sqlClient.insert({
								id: amr.id,
								table_name: amr.table_name,
								row_id: amr.row_id,
								action_record_id: amr.action_record_id,
								audience_key: amr.audience_key,
								operation: amr.operation,
								forward_patches: bindJsonParam(sqlClient, amr.forward_patches),
								reverse_patches: bindJsonParam(sqlClient, amr.reverse_patches),
								sequence: amr.sequence
							})}
							ON CONFLICT (id) DO NOTHING
						`.pipe(Effect.asVoid)
					}

					if (correctionAmrs.length > 0) {
						yield* clientDbAdapter.withCaptureContext(
							null,
							clientDbAdapter.withPatchTrackingDisabled(
								applyForwardAmrs(correctionAmrs).pipe(
									Effect.provideService(SqlClient.SqlClient, sqlClient)
								)
							)
						)
					}

					yield* actionRecordRepo.markLocallyApplied(pending.id)
					continue
				}

				if (pending._tag === RollbackActionTag) {
					yield* actionRecordRepo.markLocallyApplied(pending.id)
					continue
				}

				const actionCreator = actionRegistry.getActionCreator(pending._tag)
				if (!actionCreator) {
					return yield* Effect.fail(
						new SyncError({
							message: `Missing action creator: ${pending._tag}`
						})
					)
				}

				yield* clientDbAdapter.withCaptureContext(
					pending.id,
					deterministicId.withActionContext(pending.id, actionCreator(pending.args).execute())
				)

				yield* actionRecordRepo.markLocallyApplied(pending.id)
			}
		})

	return { replayPendingActions } as const
}
