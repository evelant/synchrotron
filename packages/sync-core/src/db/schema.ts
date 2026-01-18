import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import createSyncTablesSQL from "./sql/schema/create_sync_tables"

const requiredSyncTables = [
	"action_records",
	"action_modified_rows",
	"client_sync_status",
	"local_applied_action_ids"
] as const

/**
 * Effect that initializes the sync tables schema
 */
export const createSyncTables = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const dbDialect = sql.onDialectOrElse({
		pg: () => "postgres",
		sqlite: () => "sqlite",
		orElse: () => "unknown"
	})

	const existingBefore = yield* Effect.all(
		requiredSyncTables.map((tableName) =>
			sql<{ readonly exists: boolean }>`
				SELECT EXISTS (
					SELECT 1
					FROM information_schema.tables
					WHERE table_schema = current_schema()
					AND table_name = ${tableName}
				) AS exists
			`.pipe(Effect.map((rows) => [tableName, rows[0]?.exists === true] as const))
		),
		{ concurrency: 1 }
	)

	const existingBeforeTables = existingBefore.filter(([, exists]) => exists).map(([name]) => name)
	const hadAllSyncTablesBefore = existingBeforeTables.length === requiredSyncTables.length

	yield* Effect.logInfo("db.syncSchema.ensure.start", {
		dbDialect,
		hadAllSyncTablesBefore,
		existingTables: existingBeforeTables
	})

	// Create all sync tables and indexes (idempotent)
	yield* sql.unsafe(createSyncTablesSQL).raw

	const existingAfter = yield* Effect.all(
		requiredSyncTables.map((tableName) =>
			sql<{ readonly exists: boolean }>`
				SELECT EXISTS (
					SELECT 1
					FROM information_schema.tables
					WHERE table_schema = current_schema()
					AND table_name = ${tableName}
				) AS exists
			`.pipe(Effect.map((rows) => [tableName, rows[0]?.exists === true] as const))
		),
		{ concurrency: 1 }
	)

	const existingAfterTables = existingAfter.filter(([, exists]) => exists).map(([name]) => name)
	const hasAllSyncTablesAfter = existingAfterTables.length === requiredSyncTables.length

	yield* Effect.logInfo("db.syncSchema.ensure.done", {
		dbDialect,
		hadAllSyncTablesBefore,
		hasAllSyncTablesAfter,
		createdOrRepaired: !hadAllSyncTablesBefore && hasAllSyncTablesAfter
	})
})

/**
 * Helper function to initialize triggers for all tables that need sync
 */
export const createPatchTriggersForTables = (tables: string[]) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		yield* Effect.all(tables.map((t) => sql`SELECT create_patches_trigger(${t})`))
	})
