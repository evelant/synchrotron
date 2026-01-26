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
})
