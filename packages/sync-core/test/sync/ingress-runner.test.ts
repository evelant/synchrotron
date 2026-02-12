import { SqlClient } from "@effect/sql"
import { PgliteClient } from "@effect/sql-pglite"
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp"
import { describe, expect, it } from "@effect/vitest"
import { CorrectionActionTag } from "@synchrotron/sync-core/SyncActionTags"
import { SyncIngress } from "@synchrotron/sync-core/SyncIngress"
import { runSyncIngressRunner } from "@synchrotron/sync-core/SyncIngressRunner"
import { SyncService } from "@synchrotron/sync-core/SyncService"
import { DeterministicIdIdentityConfig } from "@synchrotron/sync-core/DeterministicId"
import { PostgresClientDbAdapter } from "@synchrotron/sync-core/PostgresClientDbAdapter"
import { Effect, Layer, LogLevel, Logger, Ref, Stream, TestClock } from "effect"

const PgliteTest = PgliteClient.layer({
	dataDir: "memory://",
	relaxedDurability: true,
	extensions: { uuid_ossp }
}).pipe(Layer.fresh)

describe("SyncIngressRunner", () => {
	it.scoped("ingests batches idempotently and gates requestSync on caughtUp", () =>
		Effect.gen(function* () {
			const syncCalls = yield* Ref.make(0)
			const stubSyncService = SyncService.of({
				_tag: "SyncService",
				executeAction: () => Effect.dieMessage("not used"),
				performSync: () => Effect.dieMessage("not used"),
				requestSync: () => Ref.update(syncCalls, (n) => n + 1).pipe(Effect.as([] as const)),
				cleanupOldActionRecords: (_retentionDays?: number) => Effect.succeed(true),
				applyActionRecords: (_remoteActions: readonly any[]) => Effect.dieMessage("not used"),
				hardResync: () => Effect.dieMessage("not used"),
				rebase: () => Effect.dieMessage("not used"),
				getQuarantinedActions: () => Effect.succeed([] as const),
				discardQuarantinedActions: () => Effect.succeed({ discardedActionCount: 0 } as const)
			})

			const actionId = crypto.randomUUID()
			const amrId = crypto.randomUUID()
			const noteId = crypto.randomUUID()
			const now = new Date()

			const actionRow = {
				server_ingest_id: 1,
				id: actionId,
				_tag: CorrectionActionTag,
				user_id: null,
				client_id: "remote",
				transaction_id: 1,
				clock: { timestamp: 1000, vector: { remote: 1 } },
				clock_time_ms: 1000,
				clock_counter: 1,
				args: { appliedActionIds: [], timestamp: 1000 },
				created_at: now,
				server_ingested_at: now,
				synced: true
			} as const

			const amrRow = {
				id: amrId,
				table_name: "notes",
				row_id: noteId,
				action_record_id: actionId,
				audience_key: "user:user-1",
				operation: "INSERT",
				forward_patches: { title: "A", content: "", user_id: "user-1" },
				reverse_patches: {},
				sequence: 0
			} as const

			const ingressLayer = Layer.succeed(
				SyncIngress,
				SyncIngress.of({
					_tag: "SyncIngress",
					events: Stream.fromIterable([
						{ _tag: "Batch", actions: [actionRow], modifiedRows: [amrRow], caughtUp: false },
						{ _tag: "Batch", actions: [actionRow], modifiedRows: [amrRow], caughtUp: true }
					])
				})
			)

			const baseLayer = Layer.mergeAll(
				PgliteTest,
				Layer.succeed(DeterministicIdIdentityConfig, { identityByTable: {} }),
				Logger.minimumLogLevel(LogLevel.Error)
			)

			const layer = Layer.mergeAll(
				PostgresClientDbAdapter.pipe(Layer.provideMerge(baseLayer)),
				ingressLayer,
				Layer.succeed(SyncService, stubSyncService)
			)

			yield* Effect.gen(function* () {
				yield* runSyncIngressRunner

				// First batch had `caughtUp: false`, second had `caughtUp: true`.
				for (let attempt = 0; attempt < 50; attempt++) {
					const calls = yield* Ref.get(syncCalls)
					if (calls === 1) break
					yield* TestClock.adjust("10 millis")
				}
				expect(yield* Ref.get(syncCalls)).toBe(1)

				const sql = yield* SqlClient.SqlClient

				const actionCountRows = yield* sql<{ readonly count: number }>`
					SELECT count(*)::int as count FROM action_records WHERE id = ${actionId}
				`
				expect(actionCountRows[0]?.count).toBe(1)

				const amrCountRows = yield* sql<{ readonly count: number }>`
					SELECT count(*)::int as count FROM action_modified_rows WHERE id = ${amrId}
				`
				expect(amrCountRows[0]?.count).toBe(1)
			}).pipe(Effect.provide(layer))
		})
	)

	it.scoped("Wakeup triggers requestSync without requiring ingestion", () =>
		Effect.gen(function* () {
			const syncCalls = yield* Ref.make(0)
			const stubSyncService = SyncService.of({
				_tag: "SyncService",
				executeAction: () => Effect.dieMessage("not used"),
				performSync: () => Effect.dieMessage("not used"),
				requestSync: () => Ref.update(syncCalls, (n) => n + 1).pipe(Effect.as([] as const)),
				cleanupOldActionRecords: (_retentionDays?: number) => Effect.succeed(true),
				applyActionRecords: (_remoteActions: readonly any[]) => Effect.dieMessage("not used"),
				hardResync: () => Effect.dieMessage("not used"),
				rebase: () => Effect.dieMessage("not used"),
				getQuarantinedActions: () => Effect.succeed([] as const),
				discardQuarantinedActions: () => Effect.succeed({ discardedActionCount: 0 } as const)
			})

			const ingressLayer = Layer.succeed(
				SyncIngress,
				SyncIngress.of({
					_tag: "SyncIngress",
					events: Stream.fromIterable([{ _tag: "Wakeup" as const }])
				})
			)

			const baseLayer = Layer.mergeAll(
				PgliteTest,
				Layer.succeed(DeterministicIdIdentityConfig, { identityByTable: {} }),
				Logger.minimumLogLevel(LogLevel.Error)
			)

			const layer = Layer.mergeAll(
				PostgresClientDbAdapter.pipe(Layer.provideMerge(baseLayer)),
				ingressLayer,
				Layer.succeed(SyncService, stubSyncService)
			)

			yield* Effect.gen(function* () {
				yield* runSyncIngressRunner

				// Give the runner fiber a brief moment to observe the wakeup.
				for (let attempt = 0; attempt < 50; attempt++) {
					const calls = yield* Ref.get(syncCalls)
					if (calls === 1) break
					yield* TestClock.adjust("10 millis")
				}

				expect(yield* Ref.get(syncCalls)).toBe(1)
			}).pipe(Effect.provide(layer))
		})
	)
})
