import { SqlClient } from "@effect/sql"
import { ClientDbAdapter } from "@synchrotron/sync-core"
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

export const setupClientDatabase = Effect.gen(function* () {
	const clientDbAdapter = yield* ClientDbAdapter
	yield* clientDbAdapter.initializeSyncSchema
	yield* createTodoTables
	yield* clientDbAdapter.installPatchCapture(["todos"])
})
