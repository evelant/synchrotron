import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import compareVectorClocksSQL from "./sql/clock/compare_vector_clocks.sql?raw"
import compareHlcSQL from "./sql/clock/compare_hlc.sql?raw"

/**
 * Effect that creates core clock comparison functions
 */
export const createClockFunctions = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	yield* sql.unsafe(compareVectorClocksSQL).raw
	yield* sql.unsafe(compareHlcSQL).raw

	yield* Effect.logInfo("Clock comparison functions created successfully")
})
