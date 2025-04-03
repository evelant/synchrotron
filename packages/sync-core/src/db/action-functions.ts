import { SqlClient } from "@effect/sql"
import { Effect } from "effect" // Import ReadonlyArray from 'effect'

// Import SQL files
// @ts-ignore - Vite raw imports
import rollbackToActionSQL from "./sql/action/rollback_to_action.sql?raw"
// @ts-ignore - Vite raw imports
import findCommonAncestorSQL from "./sql/action/find_common_ancestor.sql?raw"

/**
 * Effect that creates action record related functions
 */
export const createActionFunctions = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient

	// Create rollback_to_action function to handle rolling back to a specific action
	yield* sql.unsafe(rollbackToActionSQL)
	// Create find_common_ancestor function
	yield* sql.unsafe(findCommonAncestorSQL)

	// Log completion for debugging
	yield* Effect.logInfo("Action record functions created successfully")
})
