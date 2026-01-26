import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { HLC } from "@synchrotron/sync-core/HLC"
import {
	RemoteActionFetchError,
	SendLocalActionsDenied,
	SendLocalActionsInvalid
} from "@synchrotron/sync-core/SyncNetworkService"
import { Effect } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("SyncService: quarantine + recovery policy", () => {
	const serverNotesSnapshot = (serverSql: PgliteClient.PgliteClient) =>
		Effect.gen(function* () {
			const epochRows = yield* serverSql<{ readonly server_epoch: string }>`
				SELECT server_epoch::text AS server_epoch
				FROM sync_server_meta
				WHERE id = 1
			`
			const serverEpoch = epochRows[0]?.server_epoch ?? "test-epoch"

			const minRows = yield* serverSql<{
				readonly min_server_ingest_id: number | string | bigint | null
			}>`
				SELECT COALESCE(MIN(server_ingest_id), 0) as min_server_ingest_id
				FROM action_records
			`
			const minRetainedServerIngestId = Number(minRows[0]?.min_server_ingest_id ?? 0)

			const headRows = yield* serverSql<{ readonly max_server_ingest_id: number | string }>`
				SELECT COALESCE(MAX(server_ingest_id), 0) as max_server_ingest_id
				FROM action_records
			`
			const serverIngestId = Number(headRows[0]?.max_server_ingest_id ?? 0)

			const notes = yield* serverSql<Record<string, unknown>>`
				SELECT * FROM notes ORDER BY id ASC
			`

			return {
				serverEpoch,
				minRetainedServerIngestId,
				serverIngestId,
				serverClock: HLC.make(),
				tables: [{ tableName: "notes", rows: notes }]
			} as const
		}).pipe(
			Effect.mapError(
				(error) =>
					new RemoteActionFetchError({
						message: error instanceof Error ? error.message : String(error),
						cause: error
					})
			)
		)

	it.scoped(
		"rebase-once auto-recovers SendLocalActionsInvalid",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient
				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)

				yield* clientA.syncNetworkServiceTestHelpers.setBootstrapSnapshot(
					serverNotesSnapshot(serverSql)
				)
				yield* clientA.syncNetworkServiceTestHelpers.setSendResults([
					Effect.fail(
						new SendLocalActionsInvalid({
							message: "Simulated invalid upload (should trigger rebase)",
							code: "E_INVALID"
						})
					)
				])

				const { result: note } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "A1",
						content: "from client",
						user_id: "user-1",
						timestamp: 1000
					})
				)

				const exit = yield* clientA.syncService.performSync().pipe(Effect.exit)
				expect(exit._tag).toBe("Success")

				const quarantined = yield* clientA.syncService.getQuarantinedActions()
				expect(quarantined.length).toBe(0)

				const pending = yield* clientA.actionRecordRepo.allUnsynced()
				expect(pending.length).toBe(0)

				const serverContent = yield* serverSql<{ readonly content: string }>`
					SELECT content FROM notes WHERE id = ${note.id}
				`
				expect(serverContent[0]?.content).toBe("from client")
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 20_000 }
	)

	it.scoped(
		"SendLocalActionsDenied quarantines uploads but still applies remote actions",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient
				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)
				const clientB = yield* createTestClient("clientB", serverSql).pipe(Effect.orDie)

				yield* clientA.syncNetworkServiceTestHelpers.setSendResults([
					Effect.fail(
						new SendLocalActionsDenied({
							message: "Simulated denied upload (should quarantine)",
							code: "E_DENIED"
						})
					)
				])

				yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "Local blocked",
						content: "local",
						user_id: "user-1",
						timestamp: 1000
					})
				)

				const first = yield* clientA.syncService.performSync().pipe(Effect.exit)
				expect(first._tag).toBe("Success")

				const quarantined = yield* clientA.syncService.getQuarantinedActions()
				expect(quarantined.length).toBeGreaterThan(0)

				const { result: remoteNote } = yield* clientB.syncService.executeAction(
					clientB.testHelpers.createNoteAction({
						title: "Remote note",
						content: "from server",
						user_id: "user-1",
						timestamp: 1100
					})
				)
				yield* clientB.syncService.performSync().pipe(Effect.orDie)

				const second = yield* clientA.syncService.performSync().pipe(Effect.exit)
				expect(second._tag).toBe("Success")

				const remoteOnA = yield* clientA.noteRepo.findById(remoteNote.id)
				expect(remoteOnA._tag).toBe("Some")
				if (remoteOnA._tag === "Some") {
					expect(remoteOnA.value.content).toBe("from server")
				}
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 20_000 }
	)

	it.scoped(
		"discardQuarantinedActions rolls back and drops unsynced local work",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient
				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)

				yield* clientA.syncNetworkServiceTestHelpers.setSendResults([
					Effect.fail(
						new SendLocalActionsDenied({
							message: "Simulated denied upload (should quarantine)",
							code: "E_DENIED"
						})
					)
				])

				yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "Local blocked",
						content: "local",
						user_id: "user-1",
						timestamp: 1000
					})
				)
				yield* clientA.syncService.performSync().pipe(Effect.orDie)

				const before = yield* clientA.syncService.getQuarantinedActions()
				expect(before.length).toBeGreaterThan(0)

				const discardResult = yield* clientA.syncService
					.discardQuarantinedActions()
					.pipe(Effect.orDie)
				expect(discardResult.discardedActionCount).toBeGreaterThan(0)

				const after = yield* clientA.syncService.getQuarantinedActions()
				expect(after.length).toBe(0)

				const pendingAfter = yield* clientA.actionRecordRepo.allUnsynced()
				expect(pendingAfter.length).toBe(0)

				const localNotes = yield* clientA.noteRepo.findByTitle("Local blocked")
				expect(localNotes.length).toBe(0)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 20_000 }
	)
})
