import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { makeSqliteTestServerLayer, withSqliteTestClient } from "../helpers/SqliteTestLayers"

describe("DeterministicId collisions (SQLite clients)", () => {
	it.scoped(
		"fails with a helpful error when an action inserts two rows with the same deterministic identity",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const identityByTable = {
					notes: ["user_id", "title"],
					test_apply_patches: (row: any) => row
				} as const

				yield* withSqliteTestClient("clientA", serverSql, { identityByTable }, (client) =>
					Effect.gen(function* () {
						const sql = client.sql
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

									const updatedAt = new Date(args.timestamp).toISOString()

									yield* sql`
											INSERT INTO notes (id, title, content, user_id, updated_at)
											VALUES (${id}, ${args.title}, ${args.contentA}, ${args.user_id}, ${updatedAt})
										`.raw

									yield* sql`
											INSERT INTO notes (id, title, content, user_id, updated_at)
											VALUES (${id}, ${args.title}, ${args.contentB}, ${args.user_id}, ${updatedAt})
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

						const [noteCount] = yield* client.sql<{ readonly count: number }>`
								SELECT COUNT(*) AS count FROM notes
							`
						expect(noteCount?.count).toBe(0)

						const [actionCount] = yield* client.sql<{ readonly count: number }>`
								SELECT COUNT(*) AS count
								FROM action_records
								WHERE _tag = 'test-create-two-notes-collision'
							`
						expect(actionCount?.count).toBe(0)

						const [amrCount] = yield* client.sql<{ readonly count: number }>`
								SELECT COUNT(*) AS count FROM action_modified_rows
							`
						expect(amrCount?.count).toBe(0)
					})
				)
			}).pipe(Effect.provide(makeSqliteTestServerLayer())),
		{ timeout: 30000 }
	)
})
