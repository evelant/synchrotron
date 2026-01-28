import type { SqlClient } from "@effect/sql"
import { Effect, Option } from "effect"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ClientClockState } from "../ClientClockState"
import { compareClock, sortClocks } from "../ClockOrder"
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

			// Roll back to common ancestor, passing all local actions for context
			const commonAncestorOpt = yield* rollbackToCommonAncestor().pipe(
				Effect.map(Option.fromNullable)
			)
			const commonAncestor = Option.getOrNull(commonAncestorOpt)
			yield* Effect.logDebug(
				`Rolled back to common ancestor during reconcile: ${JSON.stringify(commonAncestor)}`
			)
			const rollbackClock = yield* clockState.incrementClock
			// even if the actual DB rollback happened in the SQL function's implicit transaction.
			const rollbackTransactionId = Date.now()
			const rollbackActionRecord = yield* actionRecordRepo.insert(
				ActionRecord.insert.make({
					id: crypto.randomUUID(),
					_tag: "RollbackAction",
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
			return yield* actionRecordRepo.allUnsynced()
		}).pipe(
			Effect.annotateLogs({ clientId, operation: "reconcile" }),
			Effect.withSpan("SyncService.reconcile", { attributes: { clientId } })
		)

	const handleNoop = () =>
		Effect.gen(function* () {
			yield* Effect.logInfo("performSync.noop")
			yield* advanceAppliedRemoteServerIngestCursor()
			return [] as const
		})

	const handleRemoteOnly = (remoteActions: readonly ActionRecord[]) =>
		Effect.gen(function* () {
			yield* Effect.logInfo("performSync.case1.applyRemote", { remoteCount: remoteActions.length })
			const rollbackActions = remoteActions.filter((a) => a._tag === "RollbackAction")
			const unappliedNonRollback = remoteActions.filter((a) => a._tag !== "RollbackAction")

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
						const targetRows = yield* sqlClient<{
							readonly id: string
							readonly clock: ActionRecord["clock"]
							readonly client_id: string
						}>`
							SELECT id, clock, client_id
							FROM action_records
							WHERE id IN ${sqlClient.in(targetIds)}
						`
						if (targetRows.length !== targetIds.length) {
							return yield* Effect.fail(
								new SyncError({
									message: `Rollback target action(s) not found locally: ${targetIds.join(", ")}`
								})
							)
						}
						const oldest = [...targetRows]
							.map((a) => ({ ...a, clientId: a.client_id }))
							.sort((a, b) =>
								compareClock(
									{ clock: a.clock, clientId: a.clientId, id: a.id },
									{ clock: b.clock, clientId: b.clientId, id: b.id }
								)
							)[0]
						forcedRollbackTarget = oldest?.id
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

			const earliestRemote = unappliedNonRollback.length
				? sortClocks(
						unappliedNonRollback.map((a) => ({
							action: a,
							clock: a.clock,
							clientId: a.client_id,
							id: a.id
						}))
					)[0]?.action
				: undefined

			const needsRollbackForLateArrival =
				latestApplied && earliestRemote
					? compareClock(
							{
								clock: earliestRemote.clock,
								clientId: earliestRemote.client_id,
								id: earliestRemote.id
							},
							{
								clock: {
									timestamp: Number(latestApplied.clock_time_ms),
									vector: {
										[latestApplied.client_id]: Number(latestApplied.clock_counter)
									}
								},
								clientId: latestApplied.client_id,
								id: latestApplied.id
							}
						) <= 0
					: false

			let rollbackTarget: string | null | undefined = forcedRollbackTarget
			if (rollbackTarget === undefined && needsRollbackForLateArrival && earliestRemote) {
				const predecessor = yield* sqlClient<{ readonly id: string }>`
					SELECT id
					FROM action_records
					WHERE (clock_time_ms, clock_counter, client_id, id) < (
						${earliestRemote.clock_time_ms},
						${earliestRemote.clock_counter},
						${earliestRemote.client_id},
						${earliestRemote.id}
					)
					ORDER BY clock_time_ms DESC, clock_counter DESC, client_id DESC, id DESC
					LIMIT 1
				`
				rollbackTarget = predecessor[0]?.id ?? null
			}

			if (rollbackTarget !== undefined) {
				yield* Effect.logInfo("performSync.case1.rematerialize", {
					remoteCount: remoteActions.length,
					rollbackTarget: rollbackTarget ?? null,
					hasRollbackAction: rollbackActions.length > 0,
					lateArrival: forcedRollbackTarget === undefined && needsRollbackForLateArrival
				})

				yield* rollbackToAction(rollbackTarget).pipe(sqlClient.withTransaction)
				for (const rb of rollbackActions) {
					yield* actionRecordRepo.markLocallyApplied(rb.id)
				}

				const actionsToReplay = yield* actionRecordRepo.findUnappliedLocally()
				const replayWithoutRollbacks = actionsToReplay.filter((a) => a._tag !== "RollbackAction")
				if (replayWithoutRollbacks.length > 0) {
					yield* applyActionRecords(replayWithoutRollbacks)
				}

				yield* advanceAppliedRemoteServerIngestCursor()
				if (!uploadsDisabled) {
					yield* sendLocalActions()
				}
				return remoteActions
			}

			// Fast-forward: apply only newly received non-rollback actions in canonical order.
			if (unappliedNonRollback.length > 0) {
				yield* applyActionRecords(unappliedNonRollback)
			}
			yield* advanceAppliedRemoteServerIngestCursor()
			if (!uploadsDisabled) {
				yield* sendLocalActions()
			}
			return remoteActions
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
				!remoteActions.find((a) => a._tag === "RollbackAction") &&
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

				// 1. Apply remote actions
				const appliedRemotes = yield* applyActionRecords(remoteActions)
				yield* advanceAppliedRemoteServerIngestCursor()
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
			yield* advanceAppliedRemoteServerIngestCursor()
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
