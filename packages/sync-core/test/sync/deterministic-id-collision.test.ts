import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("DeterministicId collisions (PGlite)", () => {
	it.scoped(
		"fails with a helpful error when an action inserts two rows with the same deterministic identity",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const identityByTable = {
					notes: ["user_id", "title"],
					test_apply_patches: (row: any) => row
				} as const

				const client = yield* createTestClient("clientA", serverSql, { identityByTable })
				const sql = client.rawSql
				const deterministicId = client.deterministicId

				const createTwoNotesCollision = client.actionRegistry.defineAction(
					"test-create-two-notes-collision",
					Schema.Struct({
						user_id: Schema.String,
						title: Schema.String,
						contentA: Schema.String,
						contentB: Schema.String,
						timestamp: Schema.Number
					}),
					(args) =>
						Effect.gen(function* () {
							const id = yield* deterministicId.forRow("notes", {
								user_id: args.user_id,
								title: args.title
							})

							yield* sql`
								INSERT INTO notes (id, title, content, user_id)
								VALUES (${id}, ${args.title}, ${args.contentA}, ${args.user_id})
							`.raw

							// Same deterministic identity → same id within the action → PK collision.
							yield* sql`
								INSERT INTO notes (id, title, content, user_id)
								VALUES (${id}, ${args.title}, ${args.contentB}, ${args.user_id})
							`.raw
						}).pipe(Effect.asVoid)
				)

				const result = yield* Effect.either(
					client.syncService.executeAction(
						createTwoNotesCollision({
							user_id: "user1",
							title: "Same Identity",
							contentA: "A",
							contentB: "B"
						})
					)
				)

				expect(result._tag).toBe("Left")
				if (result._tag === "Left") {
					expect((result.left as any)._tag).toBe("ActionExecutionError")
					const cause = (result.left as any).cause
					expect(cause).toBeInstanceOf(Error)
					expect((cause as Error).message).toContain("Row id collision while executing action")
					expect((cause as Error).message).toContain("DeterministicIdIdentityConfig")
				}

				// Transaction should roll back cleanly (no partial action record or row inserts).
				const [noteCount] = yield* client.rawSql<{ readonly count: number }>`
					SELECT COUNT(*)::int AS count FROM notes
				`
				expect(noteCount?.count).toBe(0)

				const [actionCount] = yield* client.rawSql<{ readonly count: number }>`
					SELECT COUNT(*)::int AS count
					FROM action_records
					WHERE _tag = 'test-create-two-notes-collision'
				`
				expect(actionCount?.count).toBe(0)

				const [amrCount] = yield* client.rawSql<{ readonly count: number }>`
					SELECT COUNT(*)::int AS count FROM action_modified_rows
				`
				expect(amrCount?.count).toBe(0)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
