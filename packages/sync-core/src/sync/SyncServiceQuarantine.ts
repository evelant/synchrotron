import type { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type {
	SendLocalActionsDenied,
	SendLocalActionsInvalid,
	SendLocalActionsFailure
} from "../SyncNetworkService"
import { SyncError } from "../SyncServiceErrors"

export const makeQuarantine = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly actionRecordRepo: ActionRecordRepo
	readonly clientId: string
	readonly newTraceId: Effect.Effect<string>
	readonly rollbackToAction: (targetActionId: string | null) => Effect.Effect<void, unknown, never>
}) => {
	const { sqlClient, actionRecordRepo, clientId, newTraceId, rollbackToAction } = deps

	const quarantineUnsyncedActions = (
		failure: SendLocalActionsDenied | SendLocalActionsInvalid
	): Effect.Effect<number, SyncError, never> =>
		Effect.gen(function* () {
			const actionsToQuarantine = yield* actionRecordRepo.allUnsyncedActive()
			if (actionsToQuarantine.length === 0) return 0

			const failureTag = failure._tag
			const failureCode = failure.code ?? null
			const failureMessage = failure.message

			for (const action of actionsToQuarantine) {
				yield* sqlClient`
					INSERT INTO local_quarantined_actions ${sqlClient.insert({
						action_record_id: action.id,
						failure_tag: failureTag,
						failure_code: failureCode,
						failure_message: failureMessage
					})}
					ON CONFLICT (action_record_id) DO UPDATE SET
						failure_tag = excluded.failure_tag,
						failure_code = excluded.failure_code,
						failure_message = excluded.failure_message,
						quarantined_at = excluded.quarantined_at
				`.pipe(Effect.asVoid)
			}

			yield* Effect.logWarning("sync.quarantine.applied", {
				clientId,
				failureTag,
				failureCode,
				quarantinedActionCount: actionsToQuarantine.length,
				quarantinedActionTags: actionsToQuarantine.reduce<Record<string, number>>((acc, action) => {
					acc[action._tag] = (acc[action._tag] ?? 0) + 1
					return acc
				}, {})
			})

			return actionsToQuarantine.length
		}).pipe(
			sqlClient.withTransaction,
			Effect.catchAll((error) =>
				Effect.fail(
					new SyncError({
						message: "Failed to quarantine unsynced actions",
						cause: error
					})
				)
			),
			Effect.annotateLogs({ clientId, operation: "quarantineUnsyncedActions" }),
			Effect.withSpan("SyncService.quarantineUnsyncedActions", { attributes: { clientId } })
		)

	const getQuarantinedActions = () =>
		Effect.gen(function* () {
			const rows = yield* sqlClient<{
				readonly action_record_id: string
				readonly failure_tag: string
				readonly failure_code: string | null
				readonly failure_message: string
				readonly quarantined_at: string
				readonly action_tag: string
			}>`
				SELECT
					q.action_record_id,
					q.failure_tag,
					q.failure_code,
					q.failure_message,
					q.quarantined_at,
					ar._tag as action_tag
				FROM local_quarantined_actions q
				JOIN action_records ar ON ar.id = q.action_record_id
				ORDER BY q.quarantined_at DESC
			`
			return rows
		}).pipe(
			Effect.annotateLogs({ clientId, operation: "getQuarantinedActions" }),
			Effect.withSpan("SyncService.getQuarantinedActions", { attributes: { clientId } })
		)

	const discardQuarantinedActions = () =>
		newTraceId.pipe(
			Effect.flatMap((discardId) =>
				Effect.gen(function* () {
					const unsyncedIds = yield* sqlClient<{ readonly id: string }>`
						SELECT id FROM action_records WHERE synced = 0
					`
					if (unsyncedIds.length === 0) {
						yield* sqlClient`DELETE FROM local_quarantined_actions`.pipe(Effect.asVoid)
						yield* Effect.logInfo("discardQuarantinedActions.noop", { discardId })
						return { discardedActionCount: 0 } as const
					}

					const rollbackTargetRow = yield* sqlClient<{ readonly id: string }>`
						SELECT ar.id
						FROM action_records ar
						JOIN local_applied_action_ids la ON la.action_record_id = ar.id
						WHERE ar.synced = 1
						ORDER BY ar.clock_time_ms DESC, ar.clock_counter DESC, ar.client_id DESC, ar.id DESC
						LIMIT 1
					`
					const rollbackTargetId = rollbackTargetRow[0]?.id ?? null

					yield* Effect.logWarning("discardQuarantinedActions.rollback", {
						discardId,
						rollbackTargetId,
						discardedActionCount: unsyncedIds.length
					})

					yield* rollbackToAction(rollbackTargetId)

					const ids = unsyncedIds.map((r) => r.id)
					yield* sqlClient`
						DELETE FROM action_modified_rows
						WHERE ${sqlClient.in("action_record_id", ids)}
					`.pipe(Effect.asVoid)
					yield* sqlClient`
						DELETE FROM action_records
						WHERE ${sqlClient.in("id", ids)}
					`.pipe(Effect.asVoid)
					yield* sqlClient`DELETE FROM local_quarantined_actions`.pipe(Effect.asVoid)

					yield* Effect.logInfo("discardQuarantinedActions.done", {
						discardId,
						discardedActionCount: ids.length
					})

					return { discardedActionCount: ids.length } as const
				}).pipe(
					sqlClient.withTransaction,
					Effect.annotateLogs({ clientId, discardId, operation: "discardQuarantinedActions" }),
					Effect.withSpan("SyncService.discardQuarantinedActions", {
						attributes: { clientId, discardId }
					})
				)
			)
		)

	return {
		quarantineUnsyncedActions,
		getQuarantinedActions,
		discardQuarantinedActions
	} as const
}

export type QuarantineFailure = SendLocalActionsFailure
