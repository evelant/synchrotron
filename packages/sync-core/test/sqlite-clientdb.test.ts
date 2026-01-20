import { KeyValueStore } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import {
	ActionRecordRepo,
	ActionRegistry,
	ActionModifiedRowRepo,
	ClientDbAdapter,
	ClientIdOverride,
	ClockService,
	DeterministicId,
	SqliteClientDbAdapter,
	SyncNetworkService,
	SyncService
} from "@synchrotron/sync-core"
import { Effect, Layer, Option } from "effect"
import { expect } from "vitest"
import { applyForwardAmrs, applyReverseAmrs } from "../src/PatchApplier"

const makeSqliteTestLayers = (clientId: string) => {
	const baseLayer = Layer.mergeAll(
		SqliteClient.layer({ filename: ":memory:" }),
		KeyValueStore.layerMemory,
		Layer.succeed(ClientIdOverride, clientId)
	)

	const layer0 = SqliteClientDbAdapter.pipe(Layer.provideMerge(baseLayer))
	const layer1 = ActionRegistry.Default.pipe(Layer.provideMerge(layer0))
	const layer2 = DeterministicId.Default.pipe(Layer.provideMerge(layer1))
	const layer3 = ActionRecordRepo.Default.pipe(Layer.provideMerge(layer2))
	const layer4 = ActionModifiedRowRepo.Default.pipe(Layer.provideMerge(layer3))

	const layer5 = Layer.effectDiscard(
		Effect.gen(function* () {
			const sqlClient = yield* SqlClient.SqlClient
			const clientDbAdapter = yield* ClientDbAdapter

			yield* clientDbAdapter.initializeSyncSchema

			yield* sqlClient`
				CREATE TABLE notes (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					content TEXT NOT NULL,
					audience_key TEXT NOT NULL DEFAULT 'audience:notes'
				)
			`.raw

			yield* clientDbAdapter.installPatchCapture(["notes"])
		})
	).pipe(Layer.provideMerge(layer4))

	const layer6 = ClockService.Default.pipe(Layer.provideMerge(layer5))
	const layer7 = SyncNetworkService.Default.pipe(Layer.provideMerge(layer6))

	return SyncService.DefaultWithoutDependencies.pipe(Layer.provideMerge(layer7))
}

describe("SQLite ClientDbAdapter (sqlite-node)", () => {
	it.scoped(
		"computes clock_counter for UUID-like client_id keys",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const syncService = yield* SyncService

				const action = {
					_tag: "test-sqlite-clock-counter",
					args: {},
					execute: () => Effect.void
				}

				const { actionRecord } = yield* syncService.executeAction(action)

				const rows = yield* sql<{ clock_counter: number }>`
					SELECT clock_counter
					FROM action_records
					WHERE id = ${actionRecord.id}
				`

				expect(rows).toHaveLength(1)
				expect(rows[0]!.clock_counter).toBe(1)
			}).pipe(
				Effect.provide(makeSqliteTestLayers("550e8400-e29b-41d4-a716-446655440000"))
			)
	)

	it.scoped(
		"captures INSERT/UPDATE/DELETE patches with sequences",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const syncService = yield* SyncService
				const amrRepo = yield* ActionModifiedRowRepo

				const action = {
					_tag: "test-sqlite-amr",
					args: {},
					execute: () =>
						Effect.gen(function* () {
							yield* sql`
								INSERT INTO notes (id, title, content)
								VALUES ('note-1', 'A', 'B')
							`

							yield* sql`
								UPDATE notes
								SET title = 'A2'
								WHERE id = 'note-1'
							`

							yield* sql`
								DELETE FROM notes
								WHERE id = 'note-1'
							`

							return "ok" as const
						})
				}

				const { actionRecord, result } = yield* syncService.executeAction(action)
				expect(result).toBe("ok")

				const amrs = yield* amrRepo.findByActionRecordIds([actionRecord.id])
				expect(amrs.map((a) => a.sequence)).toEqual([0, 1, 2])
				expect(amrs.map((a) => a.operation)).toEqual(["INSERT", "UPDATE", "DELETE"])
				expect(amrs.every((a) => a.table_name === "notes")).toBe(true)
				expect(amrs.every((a) => a.row_id === "note-1")).toBe(true)
				expect(amrs.every((a) => a.action_record_id === actionRecord.id)).toBe(true)

				expect(amrs[0]!.id).toBe(`${actionRecord.id}:0`)
				expect(amrs[0]!.forward_patches).toMatchObject({ id: "note-1", title: "A", content: "B" })
				expect(amrs[0]!.reverse_patches).toEqual({})

				expect(amrs[1]!.id).toBe(`${actionRecord.id}:1`)
				expect(amrs[1]!.forward_patches).toEqual({ title: "A2" })
				expect(amrs[1]!.reverse_patches).toEqual({ title: "A" })

				expect(amrs[2]!.id).toBe(`${actionRecord.id}:2`)
				expect(amrs[2]!.forward_patches).toEqual({})
				expect(amrs[2]!.reverse_patches).toMatchObject({ id: "note-1", title: "A2", content: "B" })
			}).pipe(Effect.provide(makeSqliteTestLayers("sqlite-client")))
	)

	it.scoped(
		"rejects direct writes when capture context is missing (unless tracking disabled)",
		() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient
					const clientDbAdapter = yield* ClientDbAdapter

				const directWrite = Effect.either(
					sql`
						INSERT INTO notes (id, title, content)
						VALUES ('note-direct', 'X', 'Y')
					`.raw
				)
				const directWriteResult = yield* directWrite
				expect(directWriteResult._tag).toBe("Left")

					const disabledWriteResult = yield* Effect.either(
						clientDbAdapter.withPatchTrackingDisabled(
							sql`
								INSERT INTO notes (id, title, content)
								VALUES ('note-direct', 'X', 'Y')
						`.raw
					)
				)
				expect(disabledWriteResult._tag).toBe("Right")
			}).pipe(Effect.provide(makeSqliteTestLayers("sqlite-client")))
	)

	it.scoped(
		"does not capture patches when patch tracking is disabled",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const clientDbAdapter = yield* ClientDbAdapter

				const before = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM action_modified_rows`
				expect(before[0]?.count).toBe(0)

				yield* clientDbAdapter.withPatchTrackingDisabled(
					sql`
						INSERT INTO notes (id, title, content)
						VALUES ('note-untracked', 'U', 'V')
					`.raw
				)

				const after = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM action_modified_rows`
				expect(after[0]?.count).toBe(0)

				const note = yield* sql<{ id: string }>`SELECT id FROM notes WHERE id = 'note-untracked'`
				expect(note).toHaveLength(1)
			}).pipe(Effect.provide(makeSqliteTestLayers("sqlite-client")))
	)

	it.scoped(
		"does not record UPDATE patches for no-op updates",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const syncService = yield* SyncService
				const amrRepo = yield* ActionModifiedRowRepo

				yield* syncService.executeAction({
					_tag: "seed-note",
					args: {},
					execute: () =>
						sql`
							INSERT INTO notes (id, title, content)
							VALUES ('note-1', 'A', 'B')
						`.raw
				})

				const { actionRecord } = yield* syncService.executeAction({
					_tag: "noop-update",
					args: {},
					execute: () => sql`UPDATE notes SET title = title WHERE id = 'note-1'`.raw
				})

				const amrs = yield* amrRepo.findByActionRecordIds([actionRecord.id])
				expect(amrs).toHaveLength(0)
			}).pipe(Effect.provide(makeSqliteTestLayers("sqlite-client")))
	)

	it.scoped(
		"regenerates triggers when table columns change",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const clientDbAdapter = yield* ClientDbAdapter
				const syncService = yield* SyncService
				const amrRepo = yield* ActionModifiedRowRepo

				yield* sql`ALTER TABLE notes ADD COLUMN extra TEXT NOT NULL DEFAULT ''`.raw

				yield* syncService.executeAction({
					_tag: "seed-note",
					args: {},
					execute: () =>
						sql`
							INSERT INTO notes (id, title, content)
							VALUES ('note-1', 'A', 'B')
						`.raw
				})

				const { actionRecord: beforeReinstall } = yield* syncService.executeAction({
					_tag: "update-extra-before-reinstall",
					args: {},
					execute: () => sql`UPDATE notes SET extra = 'X' WHERE id = 'note-1'`.raw
				})
				expect(yield* amrRepo.findByActionRecordIds([beforeReinstall.id])).toHaveLength(0)

				yield* clientDbAdapter.installPatchCapture(["notes"])

				const { actionRecord: afterReinstall } = yield* syncService.executeAction({
					_tag: "update-extra-after-reinstall",
					args: {},
					execute: () => sql`UPDATE notes SET extra = 'Y' WHERE id = 'note-1'`.raw
				})

				const amrs = yield* amrRepo.findByActionRecordIds([afterReinstall.id])
				expect(amrs).toHaveLength(1)
				expect(amrs[0]?.operation).toBe("UPDATE")
				expect(amrs[0]?.forward_patches).toEqual({ extra: "Y" })
				expect(amrs[0]?.reverse_patches).toEqual({ extra: "X" })
			}).pipe(Effect.provide(makeSqliteTestLayers("sqlite-client")))
	)

	it.scoped(
		"applies boolean patches by coercing to 0/1",
		() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient
					const clientDbAdapter = yield* ClientDbAdapter

				yield* sql`
					CREATE TABLE todos (
						id TEXT PRIMARY KEY,
						done INTEGER NOT NULL DEFAULT 0
					)
				`.raw

					yield* clientDbAdapter.withPatchTrackingDisabled(
						sql`
							INSERT INTO todos (id, done)
							VALUES ('todo-1', 0)
						`.raw
					)

					const amr = {
						id: "amr-1",
						table_name: "todos",
						row_id: "todo-1",
						action_record_id: "action-1",
						audience_key: "audience:test",
						operation: "UPDATE",
						forward_patches: { done: true },
						reverse_patches: { done: false },
						sequence: 0
					} as const

					yield* clientDbAdapter.withPatchTrackingDisabled(applyForwardAmrs([amr]))

				const updated = yield* sql<{ done: number }>`SELECT done FROM todos WHERE id = 'todo-1'`
				expect(updated[0]!.done).toBe(1)

					yield* clientDbAdapter.withPatchTrackingDisabled(applyReverseAmrs([amr]))

				const restored = yield* sql<{ done: number }>`SELECT done FROM todos WHERE id = 'todo-1'`
				expect(restored[0]!.done).toBe(0)
			}).pipe(Effect.provide(makeSqliteTestLayers("sqlite-client")))
	)

	it.scoped(
		"decodes action_records / action_modified_rows inserted via raw SQL (ingestion-style)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const actionRecordRepo = yield* ActionRecordRepo
				const amrRepo = yield* ActionModifiedRowRepo

				const actionRecordId = "00000000-0000-0000-0000-000000000001"
				const tag = "test-raw"
				const clientId = "c1"
				const clock = { timestamp: 123, vector: { c1: 1 } }
				const args = { timestamp: 0, message: "hi" }
				const createdAt = "2020-01-01T00:00:00.000Z"

				yield* sql`
					INSERT INTO action_records (id, server_ingest_id, _tag, client_id, transaction_id, clock, args, created_at, synced)
					VALUES (
						${actionRecordId},
						1,
						${tag},
						${clientId},
						42,
						${JSON.stringify(clock)},
						${JSON.stringify(args)},
						${createdAt},
						1
					)
				`.raw

				const found = yield* actionRecordRepo.findById(actionRecordId)
				const foundRecord = found.pipe(Option.getOrThrow)
				expect(foundRecord.clock).toEqual(clock)
				expect(foundRecord.args).toEqual(args)
				expect(foundRecord.created_at.toISOString()).toBe(createdAt)
				expect(foundRecord.synced).toBe(true)

				const amrId = "amr-raw-1"
				const tableName = "notes"
				const rowId = "note-1"

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
					)
					VALUES (
						${amrId},
						${tableName},
						${rowId},
						${actionRecordId},
						${"audience:notes"},
						${"INSERT"},
						${JSON.stringify({ id: "note-1", title: "A", content: "B" })},
						${JSON.stringify({})},
						0
					)
				`.raw

				const amrs = yield* amrRepo.findByActionRecordIds([actionRecordId])
				expect(amrs).toHaveLength(1)
				expect(amrs[0]!.forward_patches).toEqual({ id: "note-1", title: "A", content: "B" })
				expect(amrs[0]!.reverse_patches).toEqual({})
			}).pipe(Effect.provide(makeSqliteTestLayers("sqlite-client")))
	)
})
