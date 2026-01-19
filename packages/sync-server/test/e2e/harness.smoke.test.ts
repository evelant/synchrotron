import { SqlClient } from "@effect/sql"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { makeServerSqlLayer, setupServerDatabase } from "./harness"

describe("E2E harness (smoke)", () => {
	it.scoped(
		"makeServerSqlLayer provides SqlClient and can run setupServerDatabase",
		() =>
			Effect.gen(function* () {
				const layer = makeServerSqlLayer(`memory://server-${crypto.randomUUID()}`)
				const context = yield* Layer.build(layer)

				// Accessing SqlClient should succeed.
				yield* SqlClient.SqlClient.pipe(Effect.provide(context))

				// And schema initialization should run.
				yield* setupServerDatabase.pipe(Effect.provide(context))

				const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(context))
				const rows = yield* sql<{ readonly count: number | string }>`
					SELECT count(*)::int as count
					FROM notes
				`
				expect(Number(rows[0]?.count ?? 0)).toBe(0)
			}),
		{ timeout: 30000 }
	)
})

