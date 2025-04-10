import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import createPatchesTriggerSQL from "./sql/patch/create_patches_trigger.sql?raw" with { type: "text" }
import deterministicIdTriggerSQL from "./sql/patch/deterministic_id_trigger.sql?raw" with { type: "text" }
import generateOpPatchesSQL from "./sql/patch/generate_op_patches.sql?raw" with { type: "text" }
import generatePatchesSQL from "./sql/patch/generate_patches.sql?raw" with { type: "text" }
import handleInsertOperationSQL from "./sql/patch/handle_insert_operation.sql?raw" with { type: "text" }
import handleRemoveOperationSQL from "./sql/patch/handle_remove_operation.sql?raw" with { type: "text" }
import handleUpdateOperationSQL from "./sql/patch/handle_update_operation.sql?raw" with { type: "text" }

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

	// Deterministic ID trigger function (must run before generate_patches)
	yield* sql.unsafe(deterministicIdTriggerSQL).raw // Execute the new SQL

	// Main patch generation trigger function
	yield* sql.unsafe(generatePatchesSQL).raw
	// Also ensure the function to *create* the patch trigger exists
	yield* sql.unsafe(createPatchesTriggerSQL).raw // Defines create_patches_trigger(TEXT)

	yield* Effect.logInfo("Trigger functions created successfully")
})

/**
 * Applies the necessary sync triggers (deterministic ID and patch generation) to the specified tables.
 */
export const applySyncTriggers = (tableNames: string[]) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		yield* Effect.logInfo(`Applying sync triggers to tables: ${tableNames.join(", ")}`)
		// Apply deterministic ID trigger (BEFORE INSERT) then patch trigger (AFTER INSERT/UPDATE/DELETE)
		yield* Effect.all(
			tableNames.flatMap((t) => [
				sql`SELECT create_deterministic_id_trigger(${t})`,
				sql`SELECT create_patches_trigger(${t})`
			]),
			{ concurrency: "inherit" } // Allow concurrent execution if possible
		)
		yield* Effect.logInfo(`Successfully applied sync triggers.`)
	})
// Removed old createPatchTriggersForTables function
