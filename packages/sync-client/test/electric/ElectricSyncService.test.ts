import { KeyValueStore } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { PgliteClient } from "@effect/sql-pglite"
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp"
import {
	ActionModifiedRowRepo,
	ActionRecordRepo,
	ActionRegistry,
	ClientClockState,
	ClientIdOverride,
	DeterministicId,
	PostgresClientDbAdapter,
	SyncNetworkService,
	SyncService
} from "@synchrotron/sync-core"
import { createSynchrotronConfig } from "@synchrotron/sync-core/config"
import { initializeClientDatabaseSchema } from "@synchrotron/sync-core/db"
import { ClientIdentityLive } from "../../src/ClientIdentity"
import { ElectricSyncService } from "../../src/electric/ElectricSyncService"
import { Effect, Layer, LogLevel, Logger, Ref } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@electric-sql/client", () => ({
	isControlMessage: (message: any) => Boolean(message?.headers?.control),
	isChangeMessage: (message: any) => Boolean(message?.headers?.operation)
}))

vi.mock("@electric-sql/experimental", () => {
	type Subscriber = (messages: ReadonlyArray<any>) => void

	class TransactionalMultiShapeStream {
		static readonly instances: TransactionalMultiShapeStream[] = []

		private readonly subscribers: Subscriber[] = []
		private readonly errorHandlers: ((error: unknown) => void)[] = []
		private pending: ReadonlyArray<any>[] = []

		constructor(_options: unknown) {
			TransactionalMultiShapeStream.instances.push(this)
		}

		subscribe(onMessages: Subscriber, onError: (error: unknown) => void) {
			this.subscribers.push(onMessages)
			this.errorHandlers.push(onError)

			for (const batch of this.pending) onMessages(batch)
			this.pending = []

			return () => {
				const idx = this.subscribers.indexOf(onMessages)
				if (idx >= 0) this.subscribers.splice(idx, 1)
			}
		}

		emit(messages: ReadonlyArray<any>) {
			if (this.subscribers.length === 0) {
				this.pending.push(messages)
				return
			}
			for (const cb of this.subscribers) cb(messages)
		}

		fail(error: unknown) {
			for (const handler of this.errorHandlers) handler(error)
		}
	}

	return { TransactionalMultiShapeStream }
})

const PgliteTest = PgliteClient.layer({
	dataDir: "memory://",
	relaxedDurability: true,
	extensions: { uuid_ossp }
})

const TestConfig = createSynchrotronConfig({
	electricSyncUrl: "http://electric.test",
	syncRpcUrl: "http://rpc.test"
})

const baseLayer = Layer.mergeAll(
	PgliteTest,
	KeyValueStore.layerMemory,
	TestConfig,
	Logger.minimumLogLevel(LogLevel.Error)
)

const makeActionRecordMessage = (row: Record<string, unknown>, last: boolean) => ({
	shape: "action_records",
	headers: { operation: "insert", last },
	key: `action_records/${String(row.id)}`,
	value: row
})

const makeAmrMessage = (row: Record<string, unknown>, last: boolean) => ({
	shape: "action_modified_rows",
	headers: { operation: "insert", last },
	key: `action_modified_rows/${String(row.id)}`,
	value: row
})

const getMockStream = async () => {
	const mod = await import("@electric-sql/experimental")
	const instances = (mod as any).TransactionalMultiShapeStream.instances as unknown[]
	expect(instances.length).toBeGreaterThan(0)
	return instances[0] as { emit: (messages: ReadonlyArray<any>) => void }
}

describe("ElectricSyncService", () => {
	beforeEach(async () => {
		const mod = await import("@electric-sql/experimental")
		;(mod as any).TransactionalMultiShapeStream.instances.length = 0
	})

	it("triggers SyncService.performSync only when both shapes are up-to-date", async () => {
		const syncCalls = Ref.unsafeMake(0)
		const stubSyncService = SyncService.of({
			_tag: "SyncService",
			executeAction: () => Effect.dieMessage("not used"),
			performSync: () => Ref.update(syncCalls, (n) => n + 1).pipe(Effect.as([] as const)),
			cleanupOldActionRecords: (_retentionDays?: number) => Effect.succeed(true),
			applyActionRecords: (_remoteActions: readonly any[]) => Effect.dieMessage("not used"),
			hardResync: () => Effect.dieMessage("not used"),
			rebase: () => Effect.dieMessage("not used"),
			getQuarantinedActions: () => Effect.succeed([] as const),
			discardQuarantinedActions: () => Effect.succeed({ discardedActionCount: 0 } as const)
		})

		const testLayer = ElectricSyncService.Default.pipe(
			Layer.provideMerge(Layer.succeed(SyncService, stubSyncService)),
			Layer.provideMerge(ActionRecordRepo.Default),
			Layer.provideMerge(baseLayer)
		)

		const program = Effect.gen(function* () {
			yield* initializeClientDatabaseSchema

			const sql = yield* SqlClient.SqlClient
			const electric = yield* ElectricSyncService

			const stream = yield* Effect.promise(() => getMockStream())

			const actionId = crypto.randomUUID()
			const now = new Date().toISOString()
			const actionRow = {
				server_ingest_id: 1,
				id: actionId,
				_tag: "_InternalSyncApply",
				client_id: "remote",
				transaction_id: 1,
				clock: { timestamp: 1000, vector: { remote: 1 } },
				args: { appliedActionIds: [], timestamp: 1000 },
				created_at: now,
				synced: 1
			}
			const amrRow = {
				id: crypto.randomUUID(),
				table_name: "notes",
				row_id: crypto.randomUUID(),
				action_record_id: actionId,
				audience_key: "user:user-1",
				operation: "INSERT",
				forward_patches: { title: "A", content: "", user_id: "user-1" },
				reverse_patches: {},
				sequence: 0
			}

			stream.emit([makeActionRecordMessage(actionRow, true), makeAmrMessage(amrRow, false)])

			for (let attempt = 0; attempt < 50; attempt++) {
				const rows = yield* sql<{ readonly count: number }>`
							SELECT count(*)::int as count FROM action_records WHERE id = ${actionId}
						`
				if (rows[0]?.count === 1) break
				yield* Effect.sleep("10 millis")
			}
			expect(yield* Ref.get(syncCalls)).toBe(0)
			expect(yield* electric.isFullySynced()).toBe(false)

			stream.emit([makeActionRecordMessage(actionRow, true), makeAmrMessage(amrRow, true)])

			for (let attempt = 0; attempt < 50; attempt++) {
				const calls = yield* Ref.get(syncCalls)
				if (calls === 1) break
				yield* Effect.sleep("10 millis")
			}
			expect(yield* Ref.get(syncCalls)).toBe(1)
			expect(yield* electric.isFullySynced()).toBe(true)
		}).pipe(Effect.provide(testLayer), Effect.scoped)

		await Effect.runPromise(program)
	})

	it("applies Electric-ingested rows even when SyncNetworkService.fetchRemoteActions is a no-op (Electric-only mode)", async () => {
		const noopNetwork = SyncNetworkService.of({
			_tag: "SyncNetworkService",
			fetchBootstrapSnapshot: () =>
				Effect.succeed({
					serverEpoch: "test-epoch",
					minRetainedServerIngestId: 0,
					serverIngestId: 0,
					serverClock: { timestamp: 0, vector: {} },
					tables: []
				}),
			fetchRemoteActions: () =>
				Effect.succeed({
					serverEpoch: "test-epoch",
					minRetainedServerIngestId: 0,
					actions: [],
					modifiedRows: []
				} as const),
			sendLocalActions: () => Effect.succeed(true)
		})

		const testLayer = ElectricSyncService.Default.pipe(
			Layer.provideMerge(SyncService.Default),
			Layer.provideMerge(Layer.succeed(SyncNetworkService, noopNetwork)),
			Layer.provideMerge(ActionRegistry.Default),
			Layer.provideMerge(ClientClockState.Default),
			Layer.provideMerge(ActionRecordRepo.Default),
			Layer.provideMerge(ActionModifiedRowRepo.Default),
			Layer.provideMerge(DeterministicId.Default),
			Layer.provideMerge(PostgresClientDbAdapter),
			Layer.provideMerge(Layer.succeed(ClientIdOverride, "receiver")),
			Layer.provideMerge(ClientIdentityLive),
			Layer.provideMerge(baseLayer)
		)

		const program = Effect.gen(function* () {
			yield* initializeClientDatabaseSchema

			const sql = yield* SqlClient.SqlClient
			yield* sql`
					CREATE TABLE IF NOT EXISTS notes (
						id TEXT PRIMARY KEY,
						title TEXT NOT NULL,
						content TEXT NOT NULL,
						user_id TEXT NOT NULL,
						audience_key TEXT GENERATED ALWAYS AS ('user:' || user_id) STORED
					)
				`

			const electric = yield* ElectricSyncService

			const stream = yield* Effect.promise(() => getMockStream())

			expect(yield* electric.isFullySynced()).toBe(false)

			const actionId = crypto.randomUUID()
			const noteId = crypto.randomUUID()
			const now = new Date().toISOString()

			const actionRow = {
				server_ingest_id: 42,
				id: actionId,
				_tag: "_InternalSyncApply",
				client_id: "remote",
				transaction_id: 1,
				clock: { timestamp: 1000, vector: { remote: 1 } },
				args: { appliedActionIds: [], timestamp: 1000 },
				created_at: now,
				synced: 1
			}
			const amrRow = {
				id: crypto.randomUUID(),
				table_name: "notes",
				row_id: noteId,
				action_record_id: actionId,
				audience_key: "user:user-1",
				operation: "INSERT",
				forward_patches: { title: "Electric note", content: "", user_id: "user-1" },
				reverse_patches: {},
				sequence: 0
			}

			stream.emit([makeActionRecordMessage(actionRow, true), makeAmrMessage(amrRow, true)])

			for (let attempt = 0; attempt < 50; attempt++) {
				const rows = yield* sql<{ readonly count: number }>`
						SELECT count(*)::int as count FROM notes WHERE id = ${noteId}
					`
				if (rows[0]?.count === 1) break
				yield* Effect.sleep("10 millis")
			}

			const row = yield* sql<{ readonly id: string; readonly title: string }>`
					SELECT id, title FROM notes WHERE id = ${noteId}
				`
			expect(row[0]?.title).toBe("Electric note")

			const clockState = yield* ClientClockState
			const cursor = yield* clockState.getLastSeenServerIngestId
			expect(cursor).toBe(42)

			expect(yield* electric.isFullySynced()).toBe(true)
		}).pipe(Effect.provide(testLayer), Effect.scoped)

		await Effect.runPromise(program)
	})
})
