/**
 * Action-log retention + compaction helpers.
 *
 * Compaction is global (not user-scoped), so it must operate on the full sync log and bypass RLS.
 * It provides:
 * - `compactActionLogOnce`: delete old action_records beyond a retention window
 * - `startActionLogCompactor`: run compaction periodically in a daemon fiber
 * - `minRetainedServerIngestId`: compute the earliest retained ingest id (used as a client gate)
 */
import type { SqlClient } from "@effect/sql"
import { Cause, Duration, Effect, Schedule } from "effect"
import { ServerInternalError } from "../SyncServerServiceErrors"

export const makeCompaction = (deps: { readonly sql: SqlClient.SqlClient }) => {
	const { sql } = deps

	const toNumber = (value: unknown): number => {
		if (typeof value === "number") return value
		if (typeof value === "bigint") return Number(value)
		if (typeof value === "string") return Number(value)
		return Number(value)
	}

	const compactActionLogOnce = (
		retention: Duration.Duration
	): Effect.Effect<{ readonly deletedActionCount: number }, ServerInternalError, never> =>
		Effect.gen(function* () {
			const retentionMs = Duration.toMillis(retention)
			if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
				yield* Effect.logWarning("server.compaction.disabled.invalidRetention", { retentionMs })
				return { deletedActionCount: 0 } as const
			}

			// Compaction is global and must operate on the full action log (bypassing RLS filtering).
			yield* sql`SELECT set_config('synchrotron.internal_materializer', 'true', true)`

			const rows = yield* sql<{ readonly deleted_action_count: number | string }>`
				WITH deleted AS (
					DELETE FROM action_records
					WHERE server_ingest_id IS NOT NULL
					AND server_ingested_at < (NOW() - (${retentionMs} * INTERVAL '1 millisecond'))
					RETURNING 1
				)
				SELECT count(*) AS deleted_action_count FROM deleted
			`.pipe(Effect.mapError((e) => new ServerInternalError({ message: "Compaction failed", cause: e })))

			const deletedCountRaw = rows[0]?.deleted_action_count ?? 0
			const deletedActionCount =
				typeof deletedCountRaw === "number" ? deletedCountRaw : Number(deletedCountRaw ?? 0)

			yield* Effect.logInfo("server.compaction.completed", {
				retentionMs,
				deletedActionCount
			})

			return { deletedActionCount } as const
		}).pipe(
			sql.withTransaction,
			Effect.annotateLogs({ serverOperation: "compactActionLogOnce" }),
			Effect.withSpan("SyncServerService.compactActionLogOnce", {
				attributes: { retentionMs: Duration.toMillis(retention) }
			}),
			Effect.mapError((error) =>
				error instanceof ServerInternalError
					? error
					: new ServerInternalError({ message: "Compaction failed", cause: error })
			)
		)

	const startActionLogCompactor = (config: {
		readonly actionLogRetention: Duration.Duration
		readonly compactionInterval: Duration.Duration
	}) =>
		compactActionLogOnce(config.actionLogRetention).pipe(
			Effect.repeat(Schedule.spaced(config.compactionInterval)),
			Effect.catchAllCause((cause) =>
				Effect.logError("server.compaction.fiberFailed", {
					cause: Cause.pretty(cause)
				}).pipe(Effect.as({ deletedActionCount: 0 } as const))
			),
			Effect.forkDaemon,
			Effect.asVoid
		)

	const minRetainedServerIngestId = () =>
		Effect.gen(function* () {
			// Compute against the full action log, not the RLS-filtered view, since compaction is global.
			// Ensure we reset the bypass flag before issuing any user-scoped SELECTs.
			yield* sql`SELECT set_config('synchrotron.internal_materializer', 'true', true)`
			const rows = yield* sql<{
				readonly min_server_ingest_id: number | string | bigint | null
			}>`
				SELECT COALESCE(MIN(server_ingest_id), 0) AS min_server_ingest_id
				FROM action_records
			`
			yield* sql`SELECT set_config('synchrotron.internal_materializer', 'false', true)`
			return toNumber(rows[0]?.min_server_ingest_id ?? 0)
		})

	return {
		compactActionLogOnce,
		startActionLogCompactor,
		minRetainedServerIngestId,
		toNumber
	} as const
}
