import { SqlClient } from "@effect/sql"
import { ClientDbAdapter } from "@synchrotron/sync-core"
import { Effect } from "effect"

const createTodoTables = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient

	const boolFromExists = (value: unknown): boolean => value === true || value === 1 || value === "1"
	const existedBefore = yield* sql<{ readonly present: unknown }>`
		SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'todos') AS present
	`.pipe(Effect.map((rows) => boolFromExists(rows[0]?.present)))

	yield* Effect.logInfo("todoApp.db.todos.ensure.start", { existedBefore })

	yield* sql`
		CREATE TABLE IF NOT EXISTS todos (
			id TEXT PRIMARY KEY,
			text TEXT NOT NULL,
			completed BOOLEAN NOT NULL DEFAULT FALSE,
			owner_id TEXT NOT NULL
			);
		`.raw

	const existsAfter = yield* sql<{ readonly present: unknown }>`
		SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'todos') AS present
	`.pipe(Effect.map((rows) => boolFromExists(rows[0]?.present)))

	yield* Effect.logInfo("todoApp.db.todos.ensure.done", { existedBefore, existsAfter })
})

export const setupClientDatabase = Effect.gen(function* () {
	yield* Effect.logInfo("todoApp.db.setup.start")
	const clientDbAdapter = yield* ClientDbAdapter
	yield* Effect.logInfo("todoApp.db.syncSchema.ensure.start", { dbDialect: clientDbAdapter.dialect })
	yield* clientDbAdapter.initializeSyncSchema
	yield* Effect.logInfo("todoApp.db.syncSchema.ensure.done", { dbDialect: clientDbAdapter.dialect })
	yield* createTodoTables
	yield* Effect.logInfo("todoApp.db.patchCapture.install.start", { tables: ["todos"] })
	yield* clientDbAdapter.installPatchCapture(["todos"])
	yield* Effect.logInfo("todoApp.db.patchCapture.install.done", { tables: ["todos"] })
	yield* Effect.logInfo("todoApp.db.setup.done")
})
