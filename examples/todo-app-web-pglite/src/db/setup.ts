import { SqlClient } from "@effect/sql"
import { ClientDbAdapter } from "@synchrotron/sync-core"
import { Effect } from "effect"

const createTodoTables = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient

	yield* Effect.logInfo("Creating todos table...")
	yield* sql`
      CREATE TABLE IF NOT EXISTS todos (
          id TEXT PRIMARY KEY, 
          text TEXT NOT NULL,
          completed BOOLEAN NOT NULL DEFAULT FALSE,
          owner_id TEXT NOT NULL
      );
    `.raw
	yield* Effect.logInfo("Todos table created.")
})

export const setupClientDatabase = Effect.gen(function* () {
	yield* Effect.logInfo("Initializing client sync schema...")
	const clientDbAdapter = yield* ClientDbAdapter
	yield* clientDbAdapter.initializeSyncSchema
	yield* Effect.logInfo("Client sync schema initialized.")

	yield* createTodoTables

	yield* Effect.logInfo("Installing patch capture triggers for todos...")
	yield* clientDbAdapter.installPatchCapture(["todos"])
	yield* Effect.logInfo("Patch capture triggers installed for todos.")

	yield* Effect.logInfo("Client database setup complete.")
})
