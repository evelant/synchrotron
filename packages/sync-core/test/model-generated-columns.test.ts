import { KeyValueStore } from "@effect/platform"
import { Model, SqlClient } from "@effect/sql"
import { PgliteClient } from "@effect/sql-pglite"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"

class Item extends Model.Class<Item>("items")({
	id: Schema.String,
	value: Schema.String,
	project_id: Schema.String,
	// Generated column (computed from `project_id`); select-only (cannot insert/update).
	audience_key: Model.FieldOnly("select")(Schema.optional(Schema.String))
}) {}

const makeSqliteLayer = Layer.mergeAll(
	SqliteClient.layer({ filename: ":memory:" }),
	KeyValueStore.layerMemory
)

const makePgliteLayer = Layer.mergeAll(
	PgliteClient.layer({
		dataDir: "memory://",
		relaxedDurability: true
	}),
	KeyValueStore.layerMemory
)

const runGeneratedColumnUpdateTest = (dialect: "sqlite" | "pglite") =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		const repo = yield* Model.makeRepository(Item, {
			tableName: "items",
			spanPrefix: "ItemRepo",
			idColumn: "id"
		})

		yield* sql`DROP TABLE IF EXISTS items`.raw

		yield* sql`
			CREATE TABLE items (
				id TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				project_id TEXT NOT NULL,
				audience_key TEXT GENERATED ALWAYS AS ('project:' || project_id) STORED
			)
		`.raw

		const id = crypto.randomUUID()
		yield* repo.insert({ id, value: "value-1", project_id: "project-a" })

		const loaded = Option.getOrThrow(yield* repo.findById(id))
		expect(loaded.audience_key).toBe("project:project-a")

		yield* repo.update({ ...(loaded as any), value: "value-2" } as any)
		const updated = Option.getOrThrow(yield* repo.findById(id))
		expect(updated.value).toBe("value-2")
		expect(updated.audience_key).toBe("project:project-a")

		// Even if application code accidentally includes a generated column in the update payload,
		// it should not be written.
		yield* repo.update({ ...(updated as any), value: "value-3", audience_key: "evil" } as any)
		const updatedAgain = Option.getOrThrow(yield* repo.findById(id))
		expect(updatedAgain.value).toBe("value-3")
		expect(updatedAgain.audience_key).toBe("project:project-a")

		yield* sql`DROP TABLE IF EXISTS items`.raw
	}).pipe(Effect.withSpan("generatedColumn.update", { attributes: { dialect } }), Effect.scoped)

describe("Model generated columns", () => {
	it.scoped(
		"FieldOnly('select') prevents updates to generated columns (sqlite)",
		() => runGeneratedColumnUpdateTest("sqlite").pipe(Effect.provide(makeSqliteLayer)),
		{ timeout: 30000 }
	)

	it.scoped(
		"FieldOnly('select') prevents updates to generated columns (pglite)",
		() => runGeneratedColumnUpdateTest("pglite").pipe(Effect.provide(makePgliteLayer)),
		{ timeout: 30000 }
	)
})
