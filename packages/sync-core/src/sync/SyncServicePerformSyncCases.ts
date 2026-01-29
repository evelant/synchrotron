/**
 * Decision tree for `performSync`.
 *
 * Given:
 * - local pending unsynced actions
 * - remote actions that have been ingested but not yet applied locally
 *
 * Choose the appropriate strategy:
 * - noop
 * - apply remote only (fast-forward or rematerialize via rollback+replay on late arrivals)
 * - upload pending only
 * - both present: either apply-then-upload (if clocks allow) or reconcile (rollback+replay) then upload
 *
 * This module is intentionally pure orchestration; it delegates actual apply/upload/rollback operations
 * to the injected functions so the case logic stays readable and testable.
 */
import type { SqlClient } from "@effect/sql"
import { Effect, Option } from "effect"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import {
	actionLogOrderKeyFromRow,
	compareActionLogOrderKey,
	findPredecessorActionId,
	resolveOldestExistingActionId
} from "../ActionLogOrder"
import type { ClientClockState } from "../ClientClockState"
import { compareClock, sortClocks } from "../ClockOrder"
import { RollbackActionTag } from "../SyncActionTags"
import { ActionRecord } from "../models"
import { SyncError } from "../SyncServiceErrors"

export const makePerformSyncCases = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly clockState: ClientClockState
	readonly actionRecordRepo: ActionRecordRepo
	readonly clientId: string
	readonly uploadsDisabled: boolean
	readonly rollbackToAction: (targetActionId: string | null) => Effect.Effect<void, unknown, never>
	readonly rollbackToCommonAncestor: () => Effect.Effect<ActionRecord | null, unknown, never>
	readonly applyActionRecords: (
		remoteActions: readonly ActionRecord[]
	) => Effect.Effect<readonly ActionRecord[], unknown, never>
	readonly sendLocalActions: () => Effect.Effect<readonly ActionRecord[], unknown, never>
	readonly advanceAppliedRemoteServerIngestCursor: () => Effect.Effect<void, unknown, never>
}) => {
	const {
		sqlClient,
		clockState,
		actionRecordRepo,
		clientId,
		uploadsDisabled,
		rollbackToAction,
		rollbackToCommonAncestor,
		applyActionRecords,
		sendLocalActions,
		advanceAppliedRemoteServerIngestCursor
	} = deps

	const reconcile = (
		pendingActions: readonly ActionRecord[],
		remoteActions: readonly ActionRecord[],
		allLocalActions: readonly ActionRecord[]
	) =>
		Effect.gen(function* () {
			yield* Effect.logInfo(
				`Performing reconciliation. Pending: [${pendingActions.map((a) => `${a.id} (${a._tag})`).join(", ")}], Remote: [${remoteActions.map((a) => `${a.id} (${a._tag})`).join(", ")}]`
			)
			yield* Effect.logDebug(
				`All local actions provided to reconcile: [${allLocalActions.map((a) => `${a.id} (${a._tag})`).join(", ")}]`
			)

			// Roll back to common ancestor, then record a RollbackAction marker for sync history.
			const commonAncestorOpt = yield* rollbackToCommonAncestor().pipe(
				Effect.map(Option.fromNullable)
			)
			const commonAncestor = Option.getOrNull(commonAncestorOpt)
			yield* Effect.logDebug(
				`Rolled back to common ancestor during reconcile: ${JSON.stringify(commonAncestor)}`
			)
			const rollbackClock = yield* clockState.incrementClock
			const rollbackTransactionId = Date.now()
			const rollbackActionRecord = yield* actionRecordRepo.insert(
				ActionRecord.insert.make({
					id: crypto.randomUUID(),
					_tag: RollbackActionTag,
					client_id: clientId,
					clock: rollbackClock,
					args: {
						target_action_id: commonAncestor?.id ?? null,
						timestamp: rollbackClock.timestamp
					},
					synced: false,
					created_at: new Date(),
					transaction_id: rollbackTransactionId
				})
			)
			yield* Effect.logInfo(`Created RollbackAction record: ${rollbackActionRecord.id}`)

			const actionsToReplay = yield* actionRecordRepo.findUnappliedLocally()
			yield* Effect.logDebug(
				`Final list of actions to REPLAY in reconcile: [${actionsToReplay.map((a: ActionRecord) => `${a.id} (${a._tag})`).join(", ")}]`
			)
			yield* applyActionRecords(actionsToReplay)
			yield* advanceAppliedRemoteServerIngestCursor()
			return yield* actionRecordRepo.allUnsynced()
		}).pipe(
			sqlClient.withTransaction,
			Effect.annotateLogs({ clientId, operation: "reconcile" }),
			Effect.withSpan("SyncService.reconcile", { attributes: { clientId } })
		)

	const handleNoop = () =>
		Effect.gen(function* () {
			yield* Effect.logInfo("performSync.noop")
			yield* advanceAppliedRemoteServerIngestCursor()
			return [] as const
		})

	type RemoteOnlyPlan = Readonly<{
		readonly rollbackActions: readonly ActionRecord[]
		readonly unappliedNonRollback: readonly ActionRecord[]
		/**
		 * When defined, we must rollback+replay to restore a canonical local materialization before proceeding.
		 * - `null`: rollback to genesis
		 * - `string`: rollback to that action ID
		 * - `undefined`: no rollback required; we can fast-forward apply
		 */
		readonly rollbackTarget: string | null | undefined
		/**
		 * True when rollback is required due to a late-arriving remote action that sorts before the
		 * client's current applied head (as opposed to an explicit remote RollbackAction).
		 */
		readonly lateArrival: boolean
	}>

	/**
	 * Compute the "remote-only" sync plan (rollback target selection) separately from execution so
	 * the decision logic stays readable.
	 */
	const planRemoteOnly = (remoteActions: readonly ActionRecord[]) =>
		Effect.gen(function* () {
			const rollbackActions = remoteActions.filter((a) => a._tag === RollbackActionTag)
			const unappliedNonRollback = remoteActions.filter((a) => a._tag !== RollbackActionTag)

			let forcedRollbackTarget: string | null | undefined = undefined
			if (rollbackActions.length > 0) {
				const targets = rollbackActions.map((rb) => rb.args["target_action_id"] as string | null)
				const hasGenesis = targets.some((t) => t === null)
				if (hasGenesis) {
					forcedRollbackTarget = null
				} else {
					const targetIds = targets.filter(
						(t): t is string => typeof t === "string" && t.length > 0
					)
					if (targetIds.length > 0) {
						const { oldestId, missingIds } = yield* resolveOldestExistingActionId({
							sql: sqlClient,
							ids: targetIds
						})
						if (missingIds.length > 0) {
							return yield* Effect.fail(
								new SyncError({
									message: `Rollback target action(s) not found locally: ${missingIds.join(", ")}`
								})
							)
						}
						forcedRollbackTarget = oldestId ?? undefined
					}
				}
			}

			const latestApplied = yield* sqlClient<{
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

			const earliestRemote = unappliedNonRollback.reduce<ActionRecord | undefined>(
				(earliest, next) => {
					if (!earliest) return next
					return compareActionLogOrderKey(
						actionLogOrderKeyFromRow(next),
						actionLogOrderKeyFromRow(earliest)
					) < 0
						? next
						: earliest
				},
				undefined
			)

			const needsRollbackForLateArrival =
				latestApplied && earliestRemote
					? compareActionLogOrderKey(
							actionLogOrderKeyFromRow(earliestRemote),
							actionLogOrderKeyFromRow(latestApplied)
						) <= 0
					: false

			let rollbackTarget: string | null | undefined = forcedRollbackTarget
			let lateArrival = false
			if (rollbackTarget === undefined && needsRollbackForLateArrival && earliestRemote) {
				rollbackTarget = yield* findPredecessorActionId(
					sqlClient,
					actionLogOrderKeyFromRow(earliestRemote)
				)
				lateArrival = true
			}

			return {
				rollbackActions,
				unappliedNonRollback,
				rollbackTarget,
				lateArrival
			} satisfies RemoteOnlyPlan
		})

	const executeRemoteOnlyPlan = (remoteActions: readonly ActionRecord[], plan: RemoteOnlyPlan) =>
		Effect.gen(function* () {
			const { rollbackActions, unappliedNonRollback, rollbackTarget, lateArrival } = plan

			if (rollbackTarget !== undefined) {
				yield* Effect.logInfo("performSync.case1.rematerialize", {
					remoteCount: remoteActions.length,
					rollbackTarget: rollbackTarget ?? null,
					hasRollbackAction: rollbackActions.length > 0,
					lateArrival
				})

				// Rematerialization must be atomic: rollback + marking rollback markers + replay.
				yield* Effect.gen(function* () {
					yield* rollbackToAction(rollbackTarget)
					for (const rb of rollbackActions) {
						yield* actionRecordRepo.markLocallyApplied(rb.id)
					}

					const actionsToReplay = yield* actionRecordRepo.findUnappliedLocally()
					const replayWithoutRollbacks = actionsToReplay.filter((a) => a._tag !== RollbackActionTag)
					if (replayWithoutRollbacks.length > 0) {
						yield* applyActionRecords(replayWithoutRollbacks)
					}
					yield* advanceAppliedRemoteServerIngestCursor()
				}).pipe(sqlClient.withTransaction)

				if (!uploadsDisabled) {
					yield* sendLocalActions()
				}
				return remoteActions
			}

			yield* Effect.gen(function* () {
				if (unappliedNonRollback.length > 0) {
					yield* applyActionRecords(unappliedNonRollback)
				}
				yield* advanceAppliedRemoteServerIngestCursor()
			}).pipe(sqlClient.withTransaction)
			if (!uploadsDisabled) {
				yield* sendLocalActions()
			}
			return remoteActions
		})

	const handleRemoteOnly = (remoteActions: readonly ActionRecord[]) =>
		Effect.gen(function* () {
			yield* Effect.logInfo("performSync.case1.applyRemote", { remoteCount: remoteActions.length })
			const plan = yield* planRemoteOnly(remoteActions)
			return yield* executeRemoteOnlyPlan(remoteActions, plan)
		})

	const handlePendingOnly = (pendingActions: readonly ActionRecord[]) =>
		Effect.gen(function* () {
			yield* Effect.logInfo("performSync.case2.sendPending", {
				pendingCount: pendingActions.length
			})
			yield* advanceAppliedRemoteServerIngestCursor()
			return uploadsDisabled ? ([] as const) : yield* sendLocalActions()
		})

	const handlePendingAndRemote = (
		pendingActions: readonly ActionRecord[],
		remoteActions: readonly ActionRecord[]
	) =>
		Effect.gen(function* () {
			const sortedPending = sortClocks(
				pendingActions.map((a) => ({
					action: a,
					clock: a.clock,
					clientId: a.client_id,
					id: a.id
				}))
			)
			const sortedRemote = sortClocks(
				remoteActions.map((a) => ({
					action: a,
					clock: a.clock,
					clientId: a.client_id,
					id: a.id
				}))
			)

			const latestPendingAction = sortedPending[sortedPending.length - 1]?.action
			const earliestRemoteAction = sortedRemote[0]?.action

			if (!latestPendingAction || !earliestRemoteAction) {
				return yield* Effect.fail(
					new SyncError({ message: "Could not determine latest pending or earliest remote clock." })
				)
			}

			if (
				!remoteActions.find((a) => a._tag === RollbackActionTag) &&
				compareClock(
					{
						clock: latestPendingAction.clock,
						clientId: latestPendingAction.client_id,
						id: latestPendingAction.id
					},
					{
						clock: earliestRemoteAction.clock,
						clientId: earliestRemoteAction.client_id,
						id: earliestRemoteAction.id
					}
				) < 0
			) {
				yield* Effect.logInfo("performSync.case4.applyRemoteThenSendPending", {
					latestPendingActionId: latestPendingAction.id,
					earliestRemoteActionId: earliestRemoteAction.id,
					pendingCount: pendingActions.length,
					remoteCount: remoteActions.length
				})

				const appliedRemotes = yield* Effect.gen(function* () {
					const applied = yield* applyActionRecords(remoteActions)
					yield* advanceAppliedRemoteServerIngestCursor()
					return applied
				}).pipe(sqlClient.withTransaction)
				// 2. Send pending actions
				if (!uploadsDisabled) {
					yield* sendLocalActions()
				}
				// For now, returning applied remotes as they were processed first in this flow.
				return appliedRemotes
			}

			yield* Effect.logInfo("performSync.case3.reconcileThenSendPending", {
				pendingCount: pendingActions.length,
				remoteCount: remoteActions.length
			})
			const allLocalActions = yield* actionRecordRepo.all()
			yield* reconcile(pendingActions, remoteActions, allLocalActions)
			return uploadsDisabled ? ([] as const) : yield* sendLocalActions()
		})

	const run = (pendingActions: readonly ActionRecord[], remoteActions: readonly ActionRecord[]) =>
		Effect.gen(function* () {
			const hasPending = pendingActions.length > 0
			const hasRemote = remoteActions.length > 0
			if (!hasPending && !hasRemote) {
				return yield* handleNoop()
			}
			if (!hasPending && hasRemote) {
				return yield* handleRemoteOnly(remoteActions)
			}
			if (hasPending && !hasRemote) {
				return yield* handlePendingOnly(pendingActions)
			}
			if (hasPending && hasRemote) {
				return yield* handlePendingAndRemote(pendingActions, remoteActions)
			}
			return yield* Effect.dieMessage("Unreachable sync case reached")
		})

	return { run } as const
}
