/**
 * SQLite client DB adapter.
 *
 * Provides the sync runtime’s DB-specific hooks for SQLite dialects:
 * - initialize the sync schema (tables + trigger functions)
 * - install patch-capture triggers
 * - manage per-transaction capture context (so triggers attribute AMRs to an action)
 * - enable/disable patch tracking (used during replay/reset so we don't generate synthetic AMRs)
 *
 * SQLite has a few quirks compared to Postgres/PGlite:
 * - booleans are often represented as 0/1, so we coerce boolean bind params for compatibility
 * - JSON is typically stored as TEXT (handled at the binding layer, not here)
 */
import { SqlClient, type SqlError } from "@effect/sql"
import * as SqlStatement from "@effect/sql/Statement"
import { Effect, Layer } from "effect"
import { ClientDbAdapter, ClientDbAdapterError } from "./ClientDbAdapter"
import { DeterministicIdIdentityConfig } from "./DeterministicId"
import { installSqlitePatchCapture } from "./sqlite/SqlitePatchCapture"
import { initializeSqliteSyncSchema } from "./sqlite/SqliteSyncSchema"

const ensureSqliteDialect = (sql: SqlClient.SqlClient) =>
	sql.onDialectOrElse({
		sqlite: () => Effect.void,
		orElse: () =>
			Effect.fail(
				new ClientDbAdapterError({
					message: `SqliteClientDbAdapter requires a SQLite SqlClient (got non-sqlite dialect)`,
					expectedDialect: "sqlite"
				})
			)
	})

const SqliteBooleanBindCoercion = SqlStatement.setTransformer((self, sql) =>
	Effect.sync(() => {
		const isSqlite = sql.onDialectOrElse({
			sqlite: () => true,
			orElse: () => false
		})

		if (!isSqlite) return self

		const [statementSql, params] = self.compile()

		let changed = false
		const coercedParams = params.map((param) => {
			if (typeof param === "boolean") {
				changed = true
				return param ? 1 : 0
			}
			return param
		})

		return changed ? sql.unsafe(statementSql, coercedParams) : self
	})
)

const SqliteClientDbAdapterLive = Layer.effect(
	ClientDbAdapter,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		yield* ensureSqliteDialect(sql)
		const identityConfig = yield* DeterministicIdIdentityConfig
		const dbDialect = "sqlite" as const

		const initializeSyncSchema: Effect.Effect<void, SqlError.SqlError> = Effect.logDebug(
			"clientDbAdapter.initializeSyncSchema.start",
			{ dbDialect }
		).pipe(
			Effect.zipRight(initializeSqliteSyncSchema({ sql, dbDialect })),
			Effect.annotateLogs({ dbDialect }),
			Effect.withSpan("ClientDbAdapter.initializeSyncSchema", { attributes: { dbDialect } })
		)

		const installPatchCapture = (
			tableNames: ReadonlyArray<string>
		): Effect.Effect<void, SqlError.SqlError | ClientDbAdapterError> =>
			Effect.logDebug("clientDbAdapter.installPatchCapture.start", {
				dbDialect,
				tableCount: tableNames.length,
				tables: tableNames
			}).pipe(
				Effect.zipRight(
					Effect.forEach(tableNames, (tableName) => {
						if (identityConfig.identityByTable[tableName] !== undefined) return Effect.void
						return Effect.fail(
							new ClientDbAdapterError({
								message:
									`Missing deterministic row identity for tracked table "${tableName}". ` +
									`Add an entry to DeterministicIdIdentityConfig (sync-client: rowIdentityByTable) for this table.`,
								tableName
							})
						)
					})
				),
				Effect.zipRight(installSqlitePatchCapture({ sql, dbDialect, tableNames })),
				Effect.annotateLogs({ dbDialect }),
				Effect.withSpan("ClientDbAdapter.installPatchCapture", {
					attributes: { dbDialect, tableCount: tableNames.length }
				})
			)

		const setCaptureContext = (
			actionRecordId: string | null
		): Effect.Effect<void, SqlError.SqlError> =>
			Effect.logTrace("clientDbAdapter.setCaptureContext", {
				dbDialect,
				actionRecordId: actionRecordId ?? null
			}).pipe(
				Effect.zipRight(
					sql`
						UPDATE sync_context
						SET capture_action_record_id = ${actionRecordId}, sequence = 0
					`.pipe(Effect.asVoid)
				),
				Effect.annotateLogs({ dbDialect, captureActionRecordId: actionRecordId ?? null }),
				Effect.withSpan("ClientDbAdapter.setCaptureContext", {
					attributes: { dbDialect, hasCaptureContext: actionRecordId != null }
				})
			)

		const setPatchTrackingEnabled = (enabled: boolean): Effect.Effect<void, SqlError.SqlError> =>
			Effect.logTrace("clientDbAdapter.setPatchTrackingEnabled", { dbDialect, enabled }).pipe(
				Effect.zipRight(
					sql`
						UPDATE sync_context
						SET disable_tracking = ${enabled ? 0 : 1}
					`.pipe(Effect.asVoid)
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
			dialect: "sqlite",
			initializeSyncSchema,
			installPatchCapture,
			setCaptureContext,
			setPatchTrackingEnabled,
			withPatchTrackingDisabled,
			withCaptureContext
		} as const
	})
)

export const SqliteClientDbAdapter = Layer.mergeAll(
	SqliteBooleanBindCoercion,
	SqliteClientDbAdapterLive
)
