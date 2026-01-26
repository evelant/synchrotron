import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { HLC } from "@synchrotron/sync-core/HLC"
import { SendLocalActionsDenied } from "@synchrotron/sync-core/SyncNetworkService"
import { Effect } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

const serverNotesSnapshot = (serverSql: PgliteClient.PgliteClient) =>
	Effect.gen(function* () {
		const epochRows = yield* serverSql<{ readonly server_epoch: string }>`
			SELECT server_epoch::text AS server_epoch
			FROM sync_server_meta
			WHERE id = 1
		`.pipe(Effect.orDie)
		const serverEpoch = epochRows[0]?.server_epoch ?? "test-epoch"

		const minRows = yield* serverSql<{
			readonly min_server_ingest_id: number | string | bigint | null
		}>`
			SELECT COALESCE(MIN(server_ingest_id), 0) as min_server_ingest_id
			FROM action_records
		`.pipe(Effect.orDie)
		const minRetainedServerIngestId = Number(minRows[0]?.min_server_ingest_id ?? 0)

		const headRows = yield* serverSql<{ readonly max_server_ingest_id: number | string }>`
			SELECT COALESCE(MAX(server_ingest_id), 0) as max_server_ingest_id
			FROM action_records
		`.pipe(Effect.orDie)
		const serverIngestId = Number(headRows[0]?.max_server_ingest_id ?? 0)

		const notes = yield* serverSql<Record<string, unknown>>`
			SELECT * FROM notes ORDER BY id ASC
		`.pipe(Effect.orDie)

		return {
			serverEpoch,
			minRetainedServerIngestId,
			serverIngestId,
			serverClock: HLC.make(),
			tables: [{ tableName: "notes", rows: notes }]
		} as const
	})

const readServerEpoch = (serverSql: PgliteClient.PgliteClient) =>
	Effect.gen(function* () {
		const rows = yield* serverSql<{ readonly server_epoch: string }>`
			SELECT server_epoch::text AS server_epoch
			FROM sync_server_meta
			WHERE id = 1
		`.pipe(Effect.orDie)
		return rows[0]?.server_epoch ?? "unknown"
	})

describe("SyncService: server history discontinuity recovery", () => {
	it.scoped(
		"epoch mismatch triggers hardResync (no pending local actions)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient
				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)

				yield* clientA.syncNetworkServiceTestHelpers.setBootstrapSnapshot(
					serverNotesSnapshot(serverSql)
				)
				yield* clientA.syncService.performSync()

				const epochBefore = yield* readServerEpoch(serverSql)
				const localEpochBefore = yield* clientA.clockState.getServerEpoch
				expect(localEpochBefore).toBe(epochBefore)

				yield* serverSql`
					UPDATE sync_server_meta
					SET server_epoch = gen_random_uuid(), updated_at = NOW()
					WHERE id = 1
				`.pipe(Effect.orDie)

				const epochAfter = yield* readServerEpoch(serverSql)
				expect(epochAfter).not.toBe(epochBefore)

				const exit = yield* clientA.syncService.performSync().pipe(Effect.exit)
				expect(exit._tag).toBe("Success")

				const localEpochAfter = yield* clientA.clockState.getServerEpoch
				expect(localEpochAfter).toBe(epochAfter)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30_000 }
	)

	it.scoped(
		"epoch mismatch triggers rebase (pending local actions)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient
				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)

				yield* clientA.syncNetworkServiceTestHelpers.setBootstrapSnapshot(
					serverNotesSnapshot(serverSql)
				)
				yield* clientA.syncService.performSync()

				const epochBefore = yield* readServerEpoch(serverSql)

				const { result: note } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "Local note",
						content: "from client",
						user_id: "user-1",
						timestamp: 1100
					})
				)
				const pendingBefore = yield* clientA.actionRecordRepo.allUnsynced()
				expect(pendingBefore.length).toBeGreaterThan(0)
				const pendingIdsBefore = pendingBefore.map((a) => a.id)

				yield* serverSql`
					UPDATE sync_server_meta
					SET server_epoch = gen_random_uuid(), updated_at = NOW()
					WHERE id = 1
				`.pipe(Effect.orDie)
				const epochAfter = yield* readServerEpoch(serverSql)
				expect(epochAfter).not.toBe(epochBefore)

				const exit = yield* clientA.syncService.performSync().pipe(Effect.exit)
				expect(exit._tag).toBe("Success")

				const localEpochAfter = yield* clientA.clockState.getServerEpoch
				expect(localEpochAfter).toBe(epochAfter)

				const pendingAfter = yield* clientA.actionRecordRepo.allUnsynced()
				expect(pendingAfter.length).toBe(0)

				const localRows = yield* clientA.rawSql<{ readonly id: string; readonly synced: number }>`
					SELECT id, synced
					FROM action_records
					WHERE id IN ${clientA.rawSql.in(pendingIdsBefore)}
				`.pipe(Effect.orDie)
				expect(localRows.length).toBe(pendingIdsBefore.length)
				expect(localRows.every((r) => r.synced === 1)).toBe(true)

				const serverNoteRows = yield* serverSql<{ readonly content: string }>`
					SELECT content FROM notes WHERE id = ${note.id}
				`.pipe(Effect.orDie)
				expect(serverNoteRows[0]?.content).toBe("from client")
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30_000 }
	)

	it.scoped(
		"history compaction triggers hardResync (no pending local actions)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient
				const clientB = yield* createTestClient("clientB", serverSql).pipe(Effect.orDie)
				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)

				yield* clientA.syncNetworkServiceTestHelpers.setBootstrapSnapshot(
					serverNotesSnapshot(serverSql)
				)

				for (let i = 0; i < 10; i++) {
					yield* clientB.syncService.executeAction(
						clientB.testHelpers.createNoteAction({
							title: `Server ${i}`,
							content: `v${i}`,
							user_id: "user-1",
							timestamp: 1000 + i
						})
					)
				}
				yield* clientB.syncService.performSync().pipe(Effect.orDie)

				yield* serverSql`
					DELETE FROM action_records WHERE server_ingest_id <= 5
				`.pipe(Effect.orDie)

				yield* clientA.clockState.getLastSeenServerIngestId
				yield* clientA.rawSql`
					UPDATE client_sync_status
					SET last_seen_server_ingest_id = 1
					WHERE client_id = ${clientA.clientId}
				`.pipe(Effect.orDie)

				const exit = yield* clientA.syncService.performSync().pipe(Effect.exit)
				expect(exit._tag).toBe("Success")

				const lastSeen = yield* clientA.clockState.getLastSeenServerIngestId
				expect(lastSeen).toBeGreaterThanOrEqual(10)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30_000 }
	)

	it.scoped(
		"history compaction triggers rebase (pending local actions)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient
				const clientB = yield* createTestClient("clientB", serverSql).pipe(Effect.orDie)
				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)

				yield* clientA.syncNetworkServiceTestHelpers.setBootstrapSnapshot(
					serverNotesSnapshot(serverSql)
				)

				for (let i = 0; i < 10; i++) {
					yield* clientB.syncService.executeAction(
						clientB.testHelpers.createNoteAction({
							title: `Server ${i}`,
							content: `v${i}`,
							user_id: "user-1",
							timestamp: 1000 + i
						})
					)
				}
				yield* clientB.syncService.performSync().pipe(Effect.orDie)

				yield* serverSql`
					DELETE FROM action_records WHERE server_ingest_id <= 5
				`.pipe(Effect.orDie)

				const { result: note } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "Local after compaction",
						content: "from client",
						user_id: "user-1",
						timestamp: 2000
					})
				)
				const pendingIdsBefore = (yield* clientA.actionRecordRepo.allUnsynced()).map((a) => a.id)
				expect(pendingIdsBefore.length).toBeGreaterThan(0)

				yield* clientA.clockState.getLastSeenServerIngestId
				yield* clientA.rawSql`
					UPDATE client_sync_status
					SET last_seen_server_ingest_id = 1
					WHERE client_id = ${clientA.clientId}
				`.pipe(Effect.orDie)

				const exit = yield* clientA.syncService.performSync().pipe(Effect.exit)
				expect(exit._tag).toBe("Success")

				const serverNoteRows = yield* serverSql<{ readonly content: string }>`
					SELECT content FROM notes WHERE id = ${note.id}
				`.pipe(Effect.orDie)
				expect(serverNoteRows[0]?.content).toBe("from client")

				const localRows = yield* clientA.rawSql<{ readonly id: string; readonly synced: number }>`
					SELECT id, synced
					FROM action_records
					WHERE id IN ${clientA.rawSql.in(pendingIdsBefore)}
				`.pipe(Effect.orDie)
				expect(localRows.length).toBe(pendingIdsBefore.length)
				expect(localRows.every((r) => r.synced === 1)).toBe(true)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30_000 }
	)

	it.scoped(
		"epoch mismatch while quarantined requires app/user intervention (no auto-resync)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient
				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)

				yield* clientA.syncNetworkServiceTestHelpers.setBootstrapSnapshot(
					serverNotesSnapshot(serverSql)
				)
				yield* clientA.syncService.performSync()

				const epochBefore = yield* readServerEpoch(serverSql)
				expect(yield* clientA.clockState.getServerEpoch).toBe(epochBefore)

				yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "Quarantined note",
						content: "client local",
						user_id: "user-1",
						timestamp: 3000
					})
				)

				yield* clientA.syncNetworkServiceTestHelpers.setSendResults([
					Effect.fail(new SendLocalActionsDenied({ message: "denied", code: "test-denied" }))
				])

				const quarantineAttempt = yield* Effect.either(clientA.syncService.performSync())
				expect(quarantineAttempt._tag).toBe("Right")

				const quarantinedBefore = yield* clientA.syncService.getQuarantinedActions()
				expect(quarantinedBefore.length).toBe(1)

				yield* serverSql`
					UPDATE sync_server_meta
					SET server_epoch = gen_random_uuid(), updated_at = NOW()
					WHERE id = 1
				`.pipe(Effect.orDie)
				const epochAfter = yield* readServerEpoch(serverSql)
				expect(epochAfter).not.toBe(epochBefore)

				const syncAttempt = yield* Effect.either(clientA.syncService.performSync())
				expect(syncAttempt._tag).toBe("Left")
				if (syncAttempt._tag === "Left") {
					expect((syncAttempt.left as any)?._tag).toBe("SyncError")
					expect((syncAttempt.left as any)?.message ?? "").toMatch(/quarantin/i)
				}

				const quarantinedAfter = yield* clientA.syncService.getQuarantinedActions()
				expect(quarantinedAfter.length).toBe(1)
				expect(yield* clientA.clockState.getServerEpoch).toBe(epochBefore)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30_000 }
	)

	it.scoped(
		"history compaction while quarantined requires app/user intervention (no auto-resync)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient
				const clientB = yield* createTestClient("clientB", serverSql).pipe(Effect.orDie)
				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)

				yield* clientA.syncNetworkServiceTestHelpers.setBootstrapSnapshot(
					serverNotesSnapshot(serverSql)
				)

				for (let i = 0; i < 10; i++) {
					yield* clientB.syncService.executeAction(
						clientB.testHelpers.createNoteAction({
							title: `Server ${i}`,
							content: `v${i}`,
							user_id: "user-1",
							timestamp: 4000 + i
						})
					)
				}
				yield* clientB.syncService.performSync().pipe(Effect.orDie)

				yield* clientA.syncService.performSync().pipe(Effect.orDie)

				yield* serverSql`
					DELETE FROM action_records WHERE server_ingest_id <= 5
				`.pipe(Effect.orDie)

				yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "Quarantined after compaction",
						content: "client local",
						user_id: "user-1",
						timestamp: 5000
					})
				)

				yield* clientA.syncNetworkServiceTestHelpers.setSendResults([
					Effect.fail(new SendLocalActionsDenied({ message: "denied", code: "test-denied" }))
				])
				const quarantineAttempt = yield* Effect.either(clientA.syncService.performSync())
				expect(quarantineAttempt._tag).toBe("Right")
				expect((yield* clientA.syncService.getQuarantinedActions()).length).toBe(1)

				yield* clientA.rawSql`
					UPDATE client_sync_status
					SET last_seen_server_ingest_id = 1
					WHERE client_id = ${clientA.clientId}
				`.pipe(Effect.orDie)
				expect(yield* clientA.clockState.getLastSeenServerIngestId).toBe(1)

				const syncAttempt = yield* Effect.either(clientA.syncService.performSync())
				expect(syncAttempt._tag).toBe("Left")
				if (syncAttempt._tag === "Left") {
					expect((syncAttempt.left as any)?._tag).toBe("SyncError")
					expect((syncAttempt.left as any)?.message ?? "").toMatch(/quarantin/i)
				}

				expect((yield* clientA.syncService.getQuarantinedActions()).length).toBe(1)
				expect(yield* clientA.clockState.getLastSeenServerIngestId).toBe(1)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30_000 }
	)
})
