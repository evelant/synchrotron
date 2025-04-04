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
 * Initialize the database schema by creating all necessary tables, functions, and triggers
 */
export const initializeDatabaseSchema = Effect.gen(function* () {
	// Create tables first
	yield* createSyncTables

	// Create all SQL functions
	yield* createPatchFunctions
	yield* createTriggerFunctions
	yield* createClockFunctions
	yield* createActionFunctions
	yield* createAmrFunctions

	yield* Effect.logInfo("Database schema initialization complete")
})
