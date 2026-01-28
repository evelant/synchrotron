/**
 * Server fetch endpoints for sync clients.
 *
 * Returns action-log deltas (ActionRecords + ActionModifiedRows) since a given `server_ingest_id`,
 * along with metadata needed for correctness:
 * - `serverEpoch` (detect hard history discontinuities)
 * - `minRetainedServerIngestId` (retention/compaction gate)
 *
 * Reads are RLS-filtered for the authenticated user, and the user context is applied via
 * Postgres `set_config(...)` so policies can reference it.
 */
import { SqlSchema } from "@effect/sql"
import type { SqlClient } from "@effect/sql"
import { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"
import { FetchRemoteActionsCompacted } from "@synchrotron/sync-core/SyncNetworkService"
import { Effect, Schema } from "effect"
import type { ServerMetaService } from "../ServerMetaService"
import { ServerInternalError } from "../SyncServerServiceErrors"
import type { FetchActionsResult } from "../SyncServerServiceTypes"
import { SyncUserId } from "../SyncUserId"

export const makeFetch = (deps: {
	readonly sql: SqlClient.SqlClient
	readonly serverMeta: ServerMetaService
	readonly minRetainedServerIngestId: () => Effect.Effect<number, unknown, never>
}) => {
	const { sql, serverMeta, minRetainedServerIngestId } = deps

	const findActionsSince = SqlSchema.findAll({
		Request: Schema.Struct({
			clientId: Schema.String,
			sinceServerIngestId: Schema.Number,
			includeSelf: Schema.optional(Schema.Boolean)
		}),
		Result: ActionRecord,
		execute: ({ clientId, sinceServerIngestId, includeSelf }) => {
			const whereClauses = [sql`server_ingest_id > ${sinceServerIngestId}`]
			if (includeSelf !== true) {
				whereClauses.unshift(sql`client_id != ${clientId}`)
			}

			return sql`
				SELECT * FROM action_records
				${whereClauses.length > 0 ? sql`WHERE ${sql.and(whereClauses)}` : sql``}
				ORDER BY server_ingest_id ASC, id ASC
			`
		}
	})

	const findModifiedRowsForActions = SqlSchema.findAll({
		Request: Schema.Array(Schema.String),
		Result: ActionModifiedRow,
		execute: (actionIds) => sql`
			SELECT * FROM action_modified_rows
			WHERE action_record_id IN ${sql.in(actionIds)}
			ORDER BY action_record_id, sequence ASC
		`
	})

	const getActionsSince = (clientId: string, sinceServerIngestId: number, includeSelf = false) =>
		Effect.gen(function* () {
			const userId = yield* SyncUserId
			// Set the RLS context for the duration of this transaction.
			yield* sql`SELECT set_config('synchrotron.user_id', ${userId}, true)`
			yield* sql`SELECT set_config('request.jwt.claim.sub', ${userId}, true)`

			const serverEpoch = yield* serverMeta.ensureServerEpoch()
			const minRetained = yield* minRetainedServerIngestId()
			if (sinceServerIngestId + 1 < minRetained) {
				return yield* Effect.fail(
					new FetchRemoteActionsCompacted({
						message:
							"Requested action log delta is older than the server's retained history (compacted)",
						sinceServerIngestId,
						minRetainedServerIngestId: minRetained,
						serverEpoch
					})
				)
			}

			yield* Effect.logDebug("server.getActionsSince.start", {
				userId,
				clientId,
				sinceServerIngestId,
				includeSelf
			})

			const actions = yield* findActionsSince({
				clientId,
				sinceServerIngestId,
				includeSelf
			}).pipe(
				Effect.mapError(
					(error) =>
						new ServerInternalError({
							message: `Database error fetching actions: ${error.message}`,
							cause: error
						})
				)
			)

			yield* Effect.logDebug("server.getActionsSince.actions", {
				userId,
				clientId,
				sinceServerIngestId,
				includeSelf,
				actionCount: actions.length
			})

			let modifiedRows: readonly ActionModifiedRow[] = []
			if (actions.length > 0) {
				const actionIds = actions.map((a) => a.id)
				modifiedRows = yield* findModifiedRowsForActions(actionIds).pipe(
					Effect.mapError(
						(error) =>
							new ServerInternalError({
								message: `Database error fetching modified rows: ${error.message}`,
								cause: error
							})
					)
				)
				yield* Effect.logDebug("server.getActionsSince.modifiedRows", {
					userId,
					clientId,
					actionCount: actions.length,
					amrCount: modifiedRows.length
				})
			}

			return {
				serverEpoch,
				minRetainedServerIngestId: minRetained,
				actions,
				modifiedRows
			} satisfies FetchActionsResult
		}).pipe(
			sql.withTransaction,
			Effect.annotateLogs({ serverOperation: "getActionsSince", requestingClientId: clientId }),
			Effect.withSpan("SyncServerService.getActionsSince", {
				attributes: { clientId, sinceServerIngestId, includeSelf }
			}),
			Effect.catchAll((error) => {
				const unknownError = error as unknown
				if (
					unknownError instanceof FetchRemoteActionsCompacted ||
					unknownError instanceof ServerInternalError
				) {
					return Effect.fail(unknownError)
				}
				const message = unknownError instanceof Error ? unknownError.message : String(unknownError)
				return Effect.fail(
					new ServerInternalError({
						message: `Unexpected error during getActionsSince: ${message}`,
						cause: unknownError
					})
				)
			})
		)

	return { getActionsSince } as const
}
