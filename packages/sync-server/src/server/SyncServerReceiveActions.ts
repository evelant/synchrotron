import type { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { bindJsonParam } from "@synchrotron/sync-core/SqlJson"
import { CorrectionActionTag } from "@synchrotron/sync-core/SyncActionTags"
import type { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"
import {
	SendLocalActionsBehindHead,
	SendLocalActionsInternal,
	type SendLocalActionsFailure
} from "@synchrotron/sync-core/SyncNetworkService"
import { Effect } from "effect"
import {
	classifyUploadSqlError,
	hasTag,
	isSendLocalActionsFailure
} from "../SyncServerServiceUtils"
import { SyncUserId } from "../SyncUserId"
import {
	deriveForcedRollbackTargetFromUpload,
	materializeServerActionLog
} from "./SyncServerReceiveActionsMaterialize"
import { validateReceiveActionsBatch } from "./SyncServerReceiveActionsValidation"

export const makeReceiveActions = (deps: { readonly sql: SqlClient.SqlClient }) => {
	const { sql } = deps

	/**
	 * Upload ingest entrypoint.
	 *
	 * High-level flow:
	 * - validate the batch shape + JSON types (`SyncServerReceiveActionsValidation`)
	 * - enforce a coarse "head gate" using `basisServerIngestId`
	 * - insert sync-log rows idempotently (`action_records` + `action_modified_rows`)
	 * - materialize server state (rollback+replay if needed) (`SyncServerReceiveActionsMaterialize`)
	 */
	const receiveActions = (
		clientId: string,
		basisServerIngestId: number,
		actions: readonly ActionRecord[],
		amrs: readonly ActionModifiedRow[]
	): Effect.Effect<void, SendLocalActionsFailure, SyncUserId> =>
		Effect.gen(function* () {
			const userId = yield* SyncUserId
			// Set the RLS context for the duration of this transaction.
			yield* sql`SELECT set_config('synchrotron.user_id', ${userId}, true)`
			yield* sql`SELECT set_config('request.jwt.claim.sub', ${userId}, true)`

			const actionTags = actions.reduce<Record<string, number>>((acc, action) => {
				acc[action._tag] = (acc[action._tag] ?? 0) + 1
				return acc
			}, {})
			const hasCorrectionDelta = actions.some((a) => a._tag === CorrectionActionTag)

			yield* Effect.logInfo("server.receiveActions.start", {
				userId,
				clientId,
				basisServerIngestId,
				actionCount: actions.length,
				amrCount: amrs.length,
				actionTags,
				hasCorrectionDelta
			})

			if (actions.length === 0) {
				yield* Effect.logDebug("server.receiveActions.noop", { clientId })
				return
			}

			yield* validateReceiveActionsBatch({ clientId, actions, amrs })

			// Simplified correctness gate: only accept uploads from clients that are at the current
			// server ingestion head for actions visible to them (excluding their own).
			//
			// This is intentionally coarse (global), assuming honest clients:
			// - If the client is behind, it must fetch remote actions, reconcile locally, then retry.
			// - Late-arriving actions by HLC are still accepted; the server re-materializes via rollback+replay.
			const unseen = yield* sql<{
				readonly id: string
				readonly server_ingest_id: number | string
			}>`
				SELECT id, server_ingest_id
				FROM action_records
				WHERE client_id != ${clientId}
				AND server_ingest_id > ${basisServerIngestId}
				ORDER BY server_ingest_id ASC, id ASC
				LIMIT 1
			`.pipe(Effect.mapError(classifyUploadSqlError))
			if (unseen.length > 0) {
				const first = unseen[0]
				const firstUnseenServerIngestId = first
					? Number(first.server_ingest_id)
					: basisServerIngestId
				yield* Effect.logWarning("server.receiveActions.behindHead", {
					clientId,
					basisServerIngestId,
					firstUnseenActionId: first?.id ?? null,
					firstUnseenServerIngestId
				})
				return yield* Effect.fail(
					new SendLocalActionsBehindHead({
						message:
							"Client is behind the server ingestion head. Fetch remote actions, reconcile locally, then retry upload.",
						basisServerIngestId,
						firstUnseenServerIngestId,
						firstUnseenActionId: first?.id ?? undefined
					})
				)
			}
			yield* Effect.logDebug("server.receiveActions.headOk", { clientId, basisServerIngestId })

			// From here on, we need to be able to write and read the sync log regardless of the
			// requesting user's current audience membership (membership churn + late arrival).
			// Sync-table RLS policies should allow a bypass when this flag is set.
			yield* sql`SELECT set_config('synchrotron.internal_materializer', 'true', true)`
			// Allow app schemas to use deferrable FK constraints without being sensitive to the
			// transient ordering of rollback+replay inside a single transaction.
			yield* sql`SET CONSTRAINTS ALL DEFERRED`.raw

			// Insert ActionRecords and AMRs idempotently.
			for (const actionRecord of actions) {
				yield* sql`
					INSERT INTO action_records (
						server_ingest_id,
						id,
						user_id,
						client_id,
						_tag,
						args,
						clock,
						synced,
						transaction_id,
						created_at
					) VALUES (
						nextval('action_records_server_ingest_id_seq'),
						${actionRecord.id},
						${userId},
						${actionRecord.client_id},
						${actionRecord._tag},
						${bindJsonParam(sql, actionRecord.args)},
						${bindJsonParam(sql, actionRecord.clock)},
						1,
						${actionRecord.transaction_id},
						${new Date(actionRecord.created_at).toISOString()}
					)
					ON CONFLICT (id) DO NOTHING
				`.pipe(Effect.mapError(classifyUploadSqlError))
			}

			for (const modifiedRow of amrs) {
				yield* sql`
					INSERT INTO action_modified_rows (
						id,
						table_name,
						row_id,
						action_record_id,
						audience_key,
						operation,
						forward_patches,
						reverse_patches,
						sequence
					) VALUES (
						${modifiedRow.id},
						${modifiedRow.table_name},
						${modifiedRow.row_id},
						${modifiedRow.action_record_id},
						${modifiedRow.audience_key},
						${modifiedRow.operation},
						${bindJsonParam(sql, modifiedRow.forward_patches)},
						${bindJsonParam(sql, modifiedRow.reverse_patches)},
						${modifiedRow.sequence}
					)
					ON CONFLICT (id) DO NOTHING
				`.pipe(Effect.mapError(classifyUploadSqlError))
			}

			const forcedRollbackTarget = yield* deriveForcedRollbackTargetFromUpload({ sql, actions })
			yield* materializeServerActionLog({ sql, forcedRollbackTarget })

			yield* Effect.logInfo("server.receiveActions.success", {
				userId,
				clientId,
				actionCount: actions.length,
				amrCount: amrs.length,
				actionTags
			})
		}).pipe(
			sql.withTransaction,
			Effect.catchAll((error) => {
				if (isSendLocalActionsFailure(error)) return Effect.fail(error)
				if (hasTag(error, "SqlError")) {
					return Effect.fail(classifyUploadSqlError(error as SqlError))
				}

				const unknownError = error as unknown
				const message = unknownError instanceof Error ? unknownError.message : String(unknownError)
				return Effect.fail(
					new SendLocalActionsInternal({
						message: `Unexpected error during receiveActions: ${message}`
					})
				)
			}),
			Effect.annotateLogs({ serverOperation: "receiveActions", requestingClientId: clientId }),
			Effect.withSpan("SyncServerService.receiveActions", {
				attributes: { clientId, actionCount: actions.length, amrCount: amrs.length }
			})
		)

	return { receiveActions } as const
}
