import { SqlClient } from "@effect/sql"
import { ClientDbAdapter } from "@synchrotron/sync-core"
import { Effect } from "effect"

const createTodoTables = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient

	const existedBefore = yield* sql<{ readonly exists: boolean }>`
		SELECT EXISTS (
			SELECT 1
			FROM information_schema.tables
			WHERE table_schema = current_schema()
			AND table_name = 'todos'
		) AS exists
	`.pipe(Effect.map((rows) => rows[0]?.exists === true))

	yield* Effect.logInfo("todoAppWeb.db.todos.ensure.start", { existedBefore })
	yield* sql`
	      CREATE TABLE IF NOT EXISTS todos (
	          id TEXT PRIMARY KEY, 
	          text TEXT NOT NULL,
	          completed BOOLEAN NOT NULL DEFAULT FALSE,
	          project_id TEXT NOT NULL,
	          created_by TEXT NOT NULL,
	          audience_key TEXT GENERATED ALWAYS AS ('project:' || project_id) STORED
	      );
	    `.raw

	const existsAfter = yield* sql<{ readonly exists: boolean }>`
		SELECT EXISTS (
			SELECT 1
			FROM information_schema.tables
			WHERE table_schema = current_schema()
			AND table_name = 'todos'
		) AS exists
	`.pipe(Effect.map((rows) => rows[0]?.exists === true))

	yield* Effect.logInfo("todoAppWeb.db.todos.ensure.done", { existedBefore, existsAfter })
})

export const setupClientDatabase = Effect.gen(function* () {
	yield* Effect.logInfo("todoAppWeb.db.setup.start")
	const clientDbAdapter = yield* ClientDbAdapter
	yield* Effect.logInfo("todoAppWeb.db.syncSchema.ensure.start", { dbDialect: clientDbAdapter.dialect })
	yield* clientDbAdapter.initializeSyncSchema
	yield* Effect.logInfo("todoAppWeb.db.syncSchema.ensure.done", { dbDialect: clientDbAdapter.dialect })

	yield* createTodoTables

	yield* Effect.logInfo("todoAppWeb.db.patchCapture.install.start", { tables: ["todos"] })
	yield* clientDbAdapter.installPatchCapture(["todos"])
	yield* Effect.logInfo("todoAppWeb.db.patchCapture.install.done", { tables: ["todos"] })

	yield* Effect.logInfo("todoAppWeb.db.setup.done")
})
