import { SqlClient } from "@effect/sql"
import { Effect, Layer } from "effect"
import { applySyncTriggers, initializeClientDatabaseSchema } from "./db"
import { ClientDbAdapter } from "./ClientDbAdapter"

const ensurePostgresDialect = (sql: SqlClient.SqlClient) =>
	sql.onDialectOrElse({
		pg: () => Effect.void,
		orElse: () =>
			Effect.fail(
				new Error(
					`PostgresClientDbAdapter requires a Postgres/PGlite SqlClient (got non-pg dialect)`
				)
			)
	})

export const PostgresClientDbAdapter = Layer.effect(
	ClientDbAdapter,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		yield* ensurePostgresDialect(sql)

		const initializeSyncSchema = initializeClientDatabaseSchema.pipe(
			Effect.provideService(SqlClient.SqlClient, sql)
		)

		const installPatchCapture = (tableNames: ReadonlyArray<string>) =>
			applySyncTriggers(Array.from(tableNames)).pipe(Effect.provideService(SqlClient.SqlClient, sql))

		const setCaptureContext = (actionRecordId: string | null) =>
			Effect.gen(function* () {
				yield* sql`SELECT set_config('sync.capture_action_record_id', ${actionRecordId ?? ""}, true)`
			})

		const setPatchTrackingEnabled = (enabled: boolean) =>
			Effect.gen(function* () {
				yield* sql`SELECT set_config('sync.disable_trigger', ${enabled ? "false" : "true"}, true)`
			})

		const withPatchTrackingDisabled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			setPatchTrackingEnabled(false).pipe(
				Effect.zipRight(effect),
				Effect.ensuring(setPatchTrackingEnabled(true).pipe(Effect.orDie))
			)

		const withCaptureContext = <A, E, R>(actionRecordId: string | null, effect: Effect.Effect<A, E, R>) =>
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
