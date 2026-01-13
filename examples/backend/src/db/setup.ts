import { SqlClient } from "@effect/sql"
import { initializeDatabaseSchema } from "@synchrotron/sync-core"
import { Effect } from "effect"

const createTodoTables = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	yield* sql`
		CREATE TABLE IF NOT EXISTS todos (
			id TEXT PRIMARY KEY,
			text TEXT NOT NULL,
			completed BOOLEAN NOT NULL DEFAULT FALSE,
			owner_id TEXT NOT NULL
		);
	`.raw
})

export const setupServerDatabase = Effect.gen(function* () {
	yield* Effect.logInfo("Initializing server database schema...")
	yield* initializeDatabaseSchema
	yield* Effect.logInfo("Server sync schema initialized.")

	yield* createTodoTables
	yield* Effect.logInfo("Server database setup complete.")
})

