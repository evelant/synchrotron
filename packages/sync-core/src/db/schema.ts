import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
// Import SQL files
import createSyncTablesSQL from "./sql/schema/create_sync_tables.sql?raw" with { type: "text" }

/**
 * Effect that initializes the sync tables schema
 */
export const createSyncTables = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	// Create all sync tables and indexes
	yield* sql.unsafe(createSyncTablesSQL).raw

	yield* Effect.logInfo("Sync tables created successfully")
})

/**
 * Helper function to initialize triggers for all tables that need sync
 */
export const createPatchTriggersForTables = (tables: string[]) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		yield* Effect.all(tables.map((t) => sql`SELECT create_patches_trigger(${t})`))
	})
