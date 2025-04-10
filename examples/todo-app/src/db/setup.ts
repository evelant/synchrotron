import { SqlClient } from "@effect/sql"
import { applySyncTriggers, initializeDatabaseSchema } from "@synchrotron/sync-core/db" // Import applySyncTriggers
import { Effect } from "effect"

export const setupDatabase = Effect.gen(function* () {
	yield* Effect.logInfo("Initializing core database schema...")
	yield* initializeDatabaseSchema
	yield* Effect.logInfo("Core database schema initialized.")

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

	yield* Effect.logInfo("Attaching patches trigger to todos table...")
	// Apply both deterministic ID and patch triggers
	yield* applySyncTriggers(["todos"])
	yield* Effect.logInfo("Patches trigger attached to todos table.")

	yield* Effect.logInfo("Database setup complete.")
})
