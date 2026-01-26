import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { ActionRegistry, ClientDbAdapter } from "@synchrotron/sync-core"
import { Effect, Schema } from "effect"
import { withSqliteTestClient, makeSqliteTestServerLayer } from "./helpers/SqliteTestLayers"

describe("SQLite patch capture encodes booleans", () => {
	it.scoped(
		"captures BOOLEAN columns as JSON booleans (true/false), not 0/1",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				yield* withSqliteTestClient("clientA", serverSql, (client) =>
					Effect.gen(function* () {
						const sql = client.sql
						const registry = yield* ActionRegistry
						const clientDbAdapter = yield* ClientDbAdapter

						yield* sql`
							CREATE TABLE IF NOT EXISTS todos (
								id TEXT PRIMARY KEY,
								completed BOOLEAN NOT NULL DEFAULT FALSE,
								audience_key TEXT NOT NULL DEFAULT 'audience:todos'
							)
						`.raw

						yield* clientDbAdapter.installPatchCapture(["todos"])

						const createTodo = registry.defineAction(
							"test-create-todo-boolean",
							Schema.Struct({
								id: Schema.String,
								completed: Schema.Boolean,
								timestamp: Schema.Number
							}),
							(args) =>
								sql`
									INSERT INTO todos (id, completed)
									VALUES (${args.id}, ${args.completed})
								`.raw.pipe(Effect.asVoid)
						)

						const { actionRecord } = yield* client.syncService.executeAction(
							createTodo({ id: crypto.randomUUID(), completed: false })
						)

						const amrs = yield* client.actionModifiedRowRepo.findByActionRecordIds([
							actionRecord.id
						])
						expect(amrs.length).toBe(1)

						const amr = amrs[0]
						expect(amr?.operation).toBe("INSERT")
						expect(amr?.forward_patches).toHaveProperty("completed", false)
						expect(typeof (amr?.forward_patches as any).completed).toBe("boolean")
					})
				)
			}).pipe(Effect.provide(makeSqliteTestServerLayer())),
		{ timeout: 30000 }
	)
})
