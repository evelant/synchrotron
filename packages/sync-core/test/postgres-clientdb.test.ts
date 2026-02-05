import { SqlClient } from "@effect/sql"
import { describe, it } from "@effect/vitest"
import { ClientDbAdapter } from "@synchrotron/sync-core"
import { Effect } from "effect"
import { expect } from "vitest"
import { makeTestLayers } from "./helpers/TestLayers"

describe("Postgres ClientDbAdapter (PGlite)", () => {
	it.scoped(
		"rejects direct writes when capture context is missing (unless tracking disabled)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const clientDbAdapter = yield* ClientDbAdapter

				const directWriteResult = yield* Effect.either(
					sql`
						INSERT INTO notes (id, title, content, user_id)
						VALUES ('note-direct', 'X', 'Y', 'user1')
					`.raw
				)
				expect(directWriteResult._tag).toBe("Left")

				const noteAfterFailedInsert = yield* sql<{ count: number }>`
					SELECT COUNT(*)::int AS count
					FROM notes
					WHERE id = 'note-direct'
				`
				expect(noteAfterFailedInsert[0]?.count).toBe(0)

				const disabledWriteResult = yield* Effect.either(
					clientDbAdapter
						.withPatchTrackingDisabled(
							sql`
							INSERT INTO notes (id, title, content, user_id)
							VALUES ('note-direct', 'X', 'Y', 'user1')
						`.raw
						)
						.pipe(sql.withTransaction)
				)
				expect(disabledWriteResult._tag).toBe("Right")

				const amrCount = yield* sql<{ count: number }>`
					SELECT COUNT(*)::int AS count
					FROM action_modified_rows
				`
				expect(amrCount[0]?.count).toBe(0)
			}).pipe(Effect.provide(makeTestLayers("server")))
	)

	it.scoped(
		"fails fast when installing patch capture for a tracked table missing deterministic row identity config",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const clientDbAdapter = yield* ClientDbAdapter

				yield* sql`
					CREATE TABLE IF NOT EXISTS todos (
						id TEXT PRIMARY KEY,
						title TEXT NOT NULL,
						audience_key TEXT NOT NULL DEFAULT 'audience:todos'
					)
				`.raw

				const installResult = yield* Effect.either(clientDbAdapter.installPatchCapture(["todos"]))
				expect(installResult._tag).toBe("Left")
				if (installResult._tag === "Left") {
					expect((installResult.left as any)._tag).toBe("ClientDbAdapterError")
					expect((installResult.left as any).tableName).toBe("todos")
					expect((installResult.left as any).message).toContain(
						"Missing deterministic row identity"
					)
				}
			}).pipe(Effect.provide(makeTestLayers("server")))
	)

	it.scoped(
		"installs patch capture when deterministic row identity is configured for the tracked table",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const clientDbAdapter = yield* ClientDbAdapter

				yield* sql`
					CREATE TABLE IF NOT EXISTS todos (
						id TEXT PRIMARY KEY,
						title TEXT NOT NULL,
						audience_key TEXT NOT NULL DEFAULT 'audience:todos'
					)
				`.raw

				const installResult = yield* Effect.either(clientDbAdapter.installPatchCapture(["todos"]))
				expect(installResult._tag).toBe("Right")

				// Smoke: triggers are installed and should reject untracked writes.
				const directWriteResult = yield* Effect.either(
					sql`
						INSERT INTO todos (id, title)
						VALUES ('todo-direct', 'X')
					`.raw
				)
				expect(directWriteResult._tag).toBe("Left")
			}).pipe(
				Effect.provide(
					makeTestLayers("server", undefined, {
						identityByTable: {
							notes: (row: any) => row,
							test_apply_patches: (row: any) => row,
							todos: (row: any) => row
						}
					})
				)
			)
	)
})
