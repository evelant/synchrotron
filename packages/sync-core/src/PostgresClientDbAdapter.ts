/**
 * Postgres/PGlite client DB adapter.
 *
 * Provides the sync runtime’s DB-specific hooks for Postgres-compatible dialects:
 * - initialize the sync schema (tables + SQL functions)
 * - install patch-capture triggers for app tables
 * - set capture context via `set_config('sync.capture_action_record_id', ...)`
 * - enable/disable patch tracking via `set_config('sync.disable_trigger', ...)`
 *
 * Note: In browser clients (PGlite) and server-like clients (Postgres), the sync runtime uses
 * the same Postgres-compatible trigger/function shape; the adapter abstracts those details.
 */
import { SqlClient } from "@effect/sql"
import { Effect, Layer } from "effect"
import { applySyncTriggers, initializeClientDatabaseSchema } from "./db"
import { ClientDbAdapter, ClientDbAdapterError } from "./ClientDbAdapter"

const ensurePostgresDialect = (sql: SqlClient.SqlClient) =>
	sql.onDialectOrElse({
		pg: () => Effect.void,
		orElse: () =>
			Effect.fail(
				new ClientDbAdapterError({
					message: `PostgresClientDbAdapter requires a Postgres/PGlite SqlClient (got non-pg dialect)`,
					expectedDialect: "postgres"
				})
			)
	})

export const PostgresClientDbAdapter = Layer.effect(
	ClientDbAdapter,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		yield* ensurePostgresDialect(sql)
		const dbDialect = "postgres" as const

		const initializeSyncSchema = Effect.logDebug("clientDbAdapter.initializeSyncSchema.start", {
			dbDialect
		}).pipe(
			Effect.zipRight(
				initializeClientDatabaseSchema.pipe(Effect.provideService(SqlClient.SqlClient, sql))
			),
			Effect.withSpan("ClientDbAdapter.initializeSyncSchema", { attributes: { dbDialect } })
		)

		const installPatchCapture = (tableNames: ReadonlyArray<string>) =>
			Effect.logDebug("clientDbAdapter.installPatchCapture.start", {
				dbDialect,
				tableCount: tableNames.length,
				tables: tableNames
			}).pipe(
				Effect.zipRight(
					applySyncTriggers(Array.from(tableNames)).pipe(
						Effect.provideService(SqlClient.SqlClient, sql)
					)
				),
				Effect.withSpan("ClientDbAdapter.installPatchCapture", {
					attributes: { dbDialect, tableCount: tableNames.length }
				})
			)

		const setCaptureContext = (actionRecordId: string | null) =>
			Effect.logTrace("clientDbAdapter.setCaptureContext", {
				dbDialect,
				actionRecordId: actionRecordId ?? null
			}).pipe(
				Effect.zipRight(
					sql`SELECT set_config('sync.capture_action_record_id', ${actionRecordId ?? ""}, true)`.pipe(
						Effect.asVoid
					)
				),
				Effect.annotateLogs({ dbDialect, captureActionRecordId: actionRecordId ?? null }),
				Effect.withSpan("ClientDbAdapter.setCaptureContext", {
					attributes: { dbDialect, hasCaptureContext: actionRecordId != null }
				})
			)

		const setPatchTrackingEnabled = (enabled: boolean) =>
			Effect.logTrace("clientDbAdapter.setPatchTrackingEnabled", { dbDialect, enabled }).pipe(
				Effect.zipRight(
					sql`SELECT set_config('sync.disable_trigger', ${enabled ? "false" : "true"}, true)`.pipe(
						Effect.asVoid
					)
				),
				Effect.annotateLogs({ dbDialect, patchTrackingEnabled: enabled }),
				Effect.withSpan("ClientDbAdapter.setPatchTrackingEnabled", {
					attributes: { dbDialect, patchTrackingEnabled: enabled }
				})
			)

		const withPatchTrackingDisabled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			setPatchTrackingEnabled(false).pipe(
				Effect.zipRight(effect),
				Effect.ensuring(setPatchTrackingEnabled(true).pipe(Effect.orDie))
			)

		const withCaptureContext = <A, E, R>(
			actionRecordId: string | null,
			effect: Effect.Effect<A, E, R>
		) =>
			setCaptureContext(actionRecordId).pipe(
				Effect.zipRight(effect),
				Effect.ensuring(setCaptureContext(null).pipe(Effect.orDie))
			)

		return {
			dialect: "postgres",
			initializeSyncSchema,
			installPatchCapture,
			setCaptureContext,
			setPatchTrackingEnabled,
			withPatchTrackingDisabled,
			withCaptureContext
		} as const
	})
)
