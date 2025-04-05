import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import createPatchesTriggerSQL from "./sql/patch/create_patches_trigger.sql?raw" with { type: "text" }
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

	// Main trigger function
	yield* sql.unsafe(generatePatchesSQL).raw
	yield* sql.unsafe(createPatchesTriggerSQL).raw

	yield* Effect.logInfo("Trigger functions created successfully")
})
