import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import createPatchesTriggerSQL from "./sql/patch/create_patches_trigger"
import generateOpPatchesSQL from "./sql/patch/generate_op_patches"
import generatePatchesSQL from "./sql/patch/generate_patches"
import handleInsertOperationSQL from "./sql/patch/handle_insert_operation"
import handleRemoveOperationSQL from "./sql/patch/handle_remove_operation"
import handleUpdateOperationSQL from "./sql/patch/handle_update_operation"

/**
 * Effect that creates the database functions for generating and applying patches
 */
export const createPatchFunctions = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	yield* sql.unsafe(generateOpPatchesSQL).raw
	yield* sql.unsafe(handleRemoveOperationSQL).raw
	yield* sql.unsafe(handleInsertOperationSQL).raw
	yield* sql.unsafe(handleUpdateOperationSQL).raw

	yield* Effect.logInfo("Patch functions created successfully")
})

/**
 * Effect that creates the trigger functions
 */
export const createTriggerFunctions = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient

	// Main patch generation trigger function
	yield* sql.unsafe(generatePatchesSQL).raw
	// Also ensure the function to *create* the patch trigger exists
	yield* sql.unsafe(createPatchesTriggerSQL).raw // Defines create_patches_trigger(TEXT)

	yield* Effect.logInfo("Trigger functions created successfully")
})

/**
 * Applies sync patch-capture triggers to the specified tables.
 */
export const applySyncTriggers = (tableNames: string[]) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		yield* Effect.logInfo(`Applying sync triggers to tables: ${tableNames.join(", ")}`)
		// Apply patch trigger (AFTER INSERT/UPDATE/DELETE)
		yield* Effect.all(
			tableNames.map((t) => sql`SELECT create_patches_trigger(${t})`),
			{ concurrency: "inherit" } // Allow concurrent execution if possible
		)
		yield* Effect.logInfo(`Successfully applied sync triggers.`)
	})
// Removed old createPatchTriggersForTables function
