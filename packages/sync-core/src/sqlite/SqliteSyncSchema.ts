import type { SqlClient, SqlError } from "@effect/sql"
import { Effect } from "effect"
import createSyncTablesSqliteSQL from "../db/sql/schema/create_sync_tables_sqlite"

/**
 * Initializes the core sync tables for SQLite clients.
 *
 * This is used by `SqliteClientDbAdapter.initializeSyncSchema` and is responsible for:
 * - ensuring the sync tables exist (executing the schema SQL 1 statement at a time)
 * - ensuring the per-connection TEMP `sync_context` table exists and has a single row
 *
 * Note: better-sqlite3 (used by `@effect/sql-sqlite-node`) cannot prepare multi-statement SQL,
 * so the schema string must be split and executed statement-by-statement.
 */
export const initializeSqliteSyncSchema = (deps: {
	readonly sql: SqlClient.SqlClient
	readonly dbDialect: "sqlite"
}): Effect.Effect<void, SqlError.SqlError> =>
	Effect.gen(function* () {
		const { sql, dbDialect } = deps

		const requiredSyncTables = [
			"action_records",
			"action_modified_rows",
			"client_sync_status",
			"local_applied_action_ids",
			"local_quarantined_actions"
		] as const

		const boolFromExists = (value: unknown): boolean =>
			value === true || value === 1 || value === "1"

		const hasAnyTablesBefore = yield* sql<{ readonly present: unknown }>`
			SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table') AS present
		`.pipe(Effect.map((rows) => boolFromExists(rows[0]?.present)))

		const existingBefore = yield* Effect.all(
			requiredSyncTables.map((tableName) =>
				sql<{ readonly present: unknown }>`
					SELECT EXISTS (
						SELECT 1 FROM sqlite_master
						WHERE type = 'table'
						AND name = ${tableName}
					) AS present
				`.pipe(Effect.map((rows) => [tableName, boolFromExists(rows[0]?.present)] as const))
			),
			{ concurrency: 1 }
		)

		const existingBeforeTables = existingBefore
			.filter(([, exists]) => exists)
			.map(([tableName]) => tableName)
		const hadAllSyncTablesBefore = existingBeforeTables.length === requiredSyncTables.length

		const tempContextExistsBefore = yield* sql<{ readonly present: unknown }>`
			SELECT EXISTS (
				SELECT 1 FROM sqlite_temp_master
				WHERE type = 'table'
				AND name = 'sync_context'
			) AS present
		`.pipe(Effect.map((rows) => boolFromExists(rows[0]?.present)))

		yield* Effect.logInfo("db.sqlite.syncSchema.ensure.start", {
			dbDialect,
			hasAnyTablesBefore,
			hadAllSyncTablesBefore,
			existingSyncTablesBefore: existingBeforeTables,
			tempContextExistsBefore
		})

		for (const statement of createSyncTablesSqliteSQL
			.split(";")
			.map((s) => s.trim())
			.filter((s) => s.length > 0)) {
			yield* sql.unsafe(statement).raw.pipe(
				Effect.catchAll((error) =>
					Effect.logError("db.sqlite.syncSchema.statementFailed", {
						dbDialect,
						statement: statement.length > 500 ? `${statement.slice(0, 500)}…` : statement,
						errorMessage: error instanceof Error ? error.message : String(error),
						cause:
							typeof error === "object" && error !== null && "cause" in error
								? // eslint-disable-next-line @typescript-eslint/no-explicit-any
									(error as any).cause
								: undefined
					}).pipe(Effect.zipRight(Effect.fail(error)))
				)
			)
		}

		// Per-connection TEMP table used by triggers for action association + sequencing.
		yield* sql`
			CREATE TEMP TABLE IF NOT EXISTS sync_context (
				capture_action_record_id TEXT,
				sequence INTEGER NOT NULL DEFAULT 0,
				disable_tracking INTEGER NOT NULL DEFAULT 0
			)
		`.raw

		// Ensure a single row exists.
		yield* sql`DELETE FROM sync_context`.raw
		yield* sql`
			INSERT INTO sync_context (capture_action_record_id, sequence, disable_tracking)
			VALUES (NULL, 0, 0)
		`.raw

		const existingAfter = yield* Effect.all(
			requiredSyncTables.map((tableName) =>
				sql<{ readonly present: unknown }>`
					SELECT EXISTS (
						SELECT 1 FROM sqlite_master
						WHERE type = 'table'
						AND name = ${tableName}
					) AS present
				`.pipe(Effect.map((rows) => [tableName, boolFromExists(rows[0]?.present)] as const))
			),
			{ concurrency: 1 }
		)

		const existingAfterTables = existingAfter
			.filter(([, exists]) => exists)
			.map(([tableName]) => tableName)
		const hasAllSyncTablesAfter = existingAfterTables.length === requiredSyncTables.length

		const tempContextExistsAfter = yield* sql<{ readonly present: unknown }>`
			SELECT EXISTS (
				SELECT 1 FROM sqlite_temp_master
				WHERE type = 'table'
				AND name = 'sync_context'
			) AS present
		`.pipe(Effect.map((rows) => boolFromExists(rows[0]?.present)))

		yield* Effect.logInfo("db.sqlite.syncSchema.ensure.done", {
			dbDialect,
			hadAllSyncTablesBefore,
			hasAllSyncTablesAfter,
			createdOrRepaired: !hadAllSyncTablesBefore && hasAllSyncTablesAfter,
			tempContextExistsAfter
		})
	})
