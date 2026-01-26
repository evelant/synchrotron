import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeTestLayers } from "./helpers/TestLayers"

describe("AMR sequencing", () => {
	it.scoped(
		"multiple AMRs for the same row apply in sequence order (forward replay)",
		() =>
			Effect.gen(function* () {
				const sql = yield* PgliteClient.PgliteClient

				const noteId = crypto.randomUUID()

				yield* Effect.gen(function* () {
					yield* sql`SELECT set_config('sync.disable_trigger', 'true', true)`
					yield* sql`
						INSERT INTO notes (id, title, content, user_id, updated_at)
						VALUES (${noteId}, ${"Original"}, ${""}, ${"user-1"}, ${new Date(0).toISOString()})
					`
				}).pipe(sql.withTransaction)

				const actionId = crypto.randomUUID()
				yield* Effect.gen(function* () {
					yield* sql`
						INSERT INTO action_records (id, _tag, client_id, transaction_id, clock, args, synced)
						VALUES (
							${actionId},
							${"test-multi-update"},
							${"server"},
							${Date.now()},
							${sql.json({ timestamp: 1000, vector: { server: 1 } })},
							${sql.json({})},
							1
						)
					`
					yield* sql`SELECT set_config('sync.capture_action_record_id', ${actionId}, true)`
					yield* sql`SELECT set_config('sync.disable_trigger', 'false', true)`

					yield* sql`
						UPDATE notes
						SET title = ${"First"}, updated_at = ${new Date(1000).toISOString()}
						WHERE id = ${noteId}
					`
					yield* sql`
						UPDATE notes
						SET title = ${"Second"}, updated_at = ${new Date(2000).toISOString()}
						WHERE id = ${noteId}
					`
				}).pipe(sql.withTransaction)

				const amrs = yield* sql<{ id: string; sequence: number }>`
						SELECT id, sequence
						FROM action_modified_rows
						WHERE action_record_id = ${actionId}
						ORDER BY sequence ASC
					`
				expect(amrs.map((a) => a.sequence)).toEqual([0, 1])

				yield* Effect.gen(function* () {
					yield* sql`SELECT set_config('sync.disable_trigger', 'true', true)`
					yield* sql`
						UPDATE notes
						SET title = ${"Original"}, updated_at = ${new Date(0).toISOString()}
						WHERE id = ${noteId}
					`
				}).pipe(sql.withTransaction)

				yield* Effect.gen(function* () {
					yield* sql`SELECT set_config('sync.disable_trigger', 'true', true)`
					yield* sql`SELECT apply_forward_amr_batch(${sql.array(amrs.map((a) => a.id))})`
				}).pipe(sql.withTransaction)

				const row = yield* sql<{ title: string }>`SELECT title FROM notes WHERE id = ${noteId}`
				expect(row[0]?.title).toBe("Second")
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
