import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

// Import SQL files
// @ts-ignore - Vite raw imports
import generateOpPatchesSQL from "./sql/patch/generate_op_patches.sql?raw"
// @ts-ignore - Vite raw imports
import handleRemoveOperationSQL from "./sql/patch/handle_remove_operation.sql?raw"
// @ts-ignore - Vite raw imports
import handleInsertOperationSQL from "./sql/patch/handle_insert_operation.sql?raw"
// @ts-ignore - Vite raw imports
import handleUpdateOperationSQL from "./sql/patch/handle_update_operation.sql?raw"
// @ts-ignore - Vite raw imports
import generatePatchesSQL from "./sql/patch/generate_patches.sql?raw"
// @ts-ignore - Vite raw imports
import createPatchesTriggerSQL from "./sql/patch/create_patches_trigger.sql?raw"

/**
 * Effect that creates the database functions for generating and applying patches
 */
export const createPatchFunctions = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient

	// Create helper function to generate patches based on operation type
	yield* sql.unsafe(generateOpPatchesSQL).raw

	// Create helper function to handle removal operations
	yield* sql.unsafe(handleRemoveOperationSQL).raw

	// Create helper function to handle insert operations
	yield* sql.unsafe(handleInsertOperationSQL).raw

	// Create helper function to handle update operations
	yield* sql.unsafe(handleUpdateOperationSQL).raw

	yield* Effect.logInfo("Patch functions created successfully")
})

/**
 * Effect that creates the trigger functions
 */
export const createTriggerFunctions = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient

	// Main trigger function
	yield* sql.unsafe(generatePatchesSQL).raw

	// Create function to create trigger for a table
	yield* sql.unsafe(createPatchesTriggerSQL).raw

	yield* Effect.logInfo("Trigger functions created successfully")
})
