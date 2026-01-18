import { Effect } from "effect"
import { createActionFunctions } from "./action-functions"
import { createAmrFunctions } from "./amr-functions"
import { createClockFunctions } from "./clock-functions"
import { createPatchFunctions, createTriggerFunctions } from "./patch-functions"
import { createSyncTables } from "./schema"

// Re-export all the database functions and utilities
export * from "./action-functions"
export * from "./amr-functions"
export * from "./clock-functions"
export * from "./patch-functions"
export * from "./schema"

/**
 * Initialize the database schema needed by clients.
 *
 * This creates:
 * - Sync tables (`action_records`, `action_modified_rows`, etc)
 * - Patch capture trigger support functions (`generate_patches`, `create_patches_trigger`, etc)
 *
 * It intentionally does NOT create server-only PL/pgSQL runtime functions such as:
 * - `rollback_to_action`
 * - `find_common_ancestor`
 * - `compare_hlc`
 * - `apply_forward_amr_batch` / `apply_reverse_amr_batch`
 */
export const initializeClientDatabaseSchema = Effect.gen(function* () {
	yield* Effect.logInfo("db.clientSchema.initialize.start")
	// Create tables first
	yield* createSyncTables

	// Create patch generation / trigger functions (client-side patch capture)
	yield* Effect.logInfo("db.clientSchema.patchFunctions.start")
	yield* createPatchFunctions
	yield* Effect.logInfo("db.clientSchema.triggerFunctions.start")
	yield* createTriggerFunctions

	yield* Effect.logInfo("Client database schema initialization complete")
})

/**
 * Initialize the full database schema by creating all necessary tables, functions, and triggers.
 *
 * This is currently intended for the Postgres backend (and test server simulation).
 */
export const initializeDatabaseSchema = Effect.gen(function* () {
	yield* Effect.logInfo("db.schema.initialize.start")
	// Create tables first
	yield* createSyncTables

	// Create all SQL functions
	yield* Effect.logInfo("db.schema.patchFunctions.start")
	yield* createPatchFunctions
	yield* Effect.logInfo("db.schema.triggerFunctions.start")
	yield* createTriggerFunctions
	yield* Effect.logInfo("db.schema.clockFunctions.start")
	yield* createClockFunctions
	yield* Effect.logInfo("db.schema.actionFunctions.start")
	yield* createActionFunctions
	yield* Effect.logInfo("db.schema.amrFunctions.start")
	yield* createAmrFunctions

	yield* Effect.logInfo("Database schema initialization complete")
})
