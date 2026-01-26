import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeTestLayers } from "./helpers/TestLayers"

describe("AMR apply idempotency", () => {
	it.scoped(
		"apply_forward_amr is idempotent for INSERT operations",
		() =>
			Effect.gen(function* () {
				const sql = yield* PgliteClient.PgliteClient

				yield* sql`
					CREATE TABLE IF NOT EXISTS test_amr_idempotent_insert (
						id TEXT PRIMARY KEY,
						value TEXT NOT NULL,
						audience_key TEXT GENERATED ALWAYS AS ('row:' || id) STORED
					)
				`

				const actionRecordId = crypto.randomUUID()
				const amrId = crypto.randomUUID()
				const rowId = crypto.randomUUID()

				yield* sql`
					INSERT INTO action_records (id, _tag, client_id, transaction_id, clock, args, synced)
					VALUES (
						${actionRecordId},
						${"test-amr-insert"},
						${"server"},
						${Date.now()},
						${sql.json({ timestamp: 1000, vector: { server: 1 } })},
						${sql.json({})},
						1
					)
				`

				yield* sql`
					INSERT INTO action_modified_rows (
						id,
						table_name,
						row_id,
						action_record_id,
						audience_key,
						operation,
						forward_patches,
						reverse_patches,
						sequence
					) VALUES (
						${amrId},
						${"test_amr_idempotent_insert"},
						${rowId},
						${actionRecordId},
						${`row:${rowId}`},
						${"INSERT"},
						${sql.json({ value: "value-1" })},
						${sql.json({})},
						0
					)
				`

				yield* sql`SELECT set_config('sync.disable_trigger', 'true', true)`
				yield* sql`SELECT apply_forward_amr(${amrId})`
				yield* sql`SELECT apply_forward_amr(${amrId})`

				const row = yield* sql<{ id: string; value: string }>`
						SELECT id, value FROM test_amr_idempotent_insert WHERE id = ${rowId}
					`
				expect(row[0]?.value).toBe("value-1")
			}).pipe(
				Effect.ensuring(
					Effect.gen(function* () {
						const sql = yield* PgliteClient.PgliteClient
						yield* sql`DROP TABLE IF EXISTS test_amr_idempotent_insert`
					}).pipe(Effect.orDie)
				),
				Effect.provide(makeTestLayers("server"))
			),
		{ timeout: 30000 }
	)

	it.scoped(
		"apply_forward_amr supplies base-table audience_key from AMR audience_key when patches omit it",
		() =>
			Effect.gen(function* () {
				const sql = yield* PgliteClient.PgliteClient

				yield* sql`
					CREATE TABLE IF NOT EXISTS test_amr_insert_audience_key (
						id TEXT PRIMARY KEY,
						value TEXT NOT NULL,
						audience_key TEXT NOT NULL
					)
				`

				const actionRecordId = crypto.randomUUID()
				const amrId = crypto.randomUUID()
				const rowId = crypto.randomUUID()
				const audienceKey = `audience:${crypto.randomUUID()}`

				yield* sql`
					INSERT INTO action_records (id, _tag, client_id, transaction_id, clock, args, synced)
					VALUES (
						${actionRecordId},
						${"test-amr-insert-audience-key"},
						${"server"},
						${Date.now()},
						${sql.json({ timestamp: 1000, vector: { server: 1 } })},
						${sql.json({})},
						1
					)
				`

				// forward_patches intentionally omits audience_key; it should still be applied to the base table.
				yield* sql`
					INSERT INTO action_modified_rows (
						id,
						table_name,
						row_id,
						action_record_id,
						audience_key,
						operation,
						forward_patches,
						reverse_patches,
						sequence
					) VALUES (
						${amrId},
						${"test_amr_insert_audience_key"},
						${rowId},
						${actionRecordId},
						${audienceKey},
						${"INSERT"},
						${sql.json({ value: "value-1" })},
						${sql.json({})},
						0
					)
				`

				yield* sql`SELECT set_config('sync.disable_trigger', 'true', true)`
				yield* sql`SELECT apply_forward_amr(${amrId})`

				const row = yield* sql<{ id: string; value: string; audience_key: string }>`
						SELECT id, value, audience_key
						FROM test_amr_insert_audience_key
						WHERE id = ${rowId}
					`
				expect(row[0]?.value).toBe("value-1")
				expect(row[0]?.audience_key).toBe(audienceKey)
			}).pipe(
				Effect.ensuring(
					Effect.gen(function* () {
						const sql = yield* PgliteClient.PgliteClient
						yield* sql`DROP TABLE IF EXISTS test_amr_insert_audience_key`
					}).pipe(Effect.orDie)
				),
				Effect.provide(makeTestLayers("server"))
			),
		{ timeout: 30000 }
	)
})
