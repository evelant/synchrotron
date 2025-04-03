import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

// Import SQL files
// @ts-ignore - Vite raw imports
import compareVectorClocksSQL from "./sql/clock/compare_vector_clocks.sql?raw"
// @ts-ignore - Vite raw imports
import compareHlcSQL from "./sql/clock/compare_hlc.sql?raw"

/**
 * Effect that creates core clock comparison functions
 */
export const createClockFunctions = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient

	// Create vector clock comparison function
	yield* sql.unsafe(compareVectorClocksSQL).raw

	// Create HLC comparison function that combines timestamp and vector clock comparison
	yield* sql.unsafe(compareHlcSQL).raw

	yield* Effect.logInfo("Clock comparison functions created successfully")
})
