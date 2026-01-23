import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { HLC } from "@synchrotron/sync-core/HLC"
import { RemoteActionFetchError } from "@synchrotron/sync-core/SyncNetworkService"
import { Effect } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("Resync primitives (hard resync + rebase)", () => {
	const serverNotesSnapshot = (serverSql: PgliteClient.PgliteClient) =>
		Effect.gen(function* () {
			const headRows = yield* serverSql<{ readonly max_server_ingest_id: number | string }>`
				SELECT COALESCE(MAX(server_ingest_id), 0) as max_server_ingest_id
				FROM action_records
			`
			const serverIngestId = Number(headRows[0]?.max_server_ingest_id ?? 0)

			const notes = yield* serverSql<Record<string, unknown>>`
				SELECT * FROM notes ORDER BY id ASC
			`

			return {
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
		"hardResync discards local state and bootstraps from server snapshot",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const clientB = yield* createTestClient("clientB", serverSql).pipe(Effect.orDie)
				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)

				const { result: serverNote } = yield* clientB.syncService.executeAction(
					clientB.testHelpers.createNoteAction({
						title: "Server note",
						content: "from server",
						user_id: "user-1",
						timestamp: 1000
					})
				)
				yield* clientB.syncService.performSync()

				yield* clientA.syncNetworkServiceTestHelpers.setBootstrapSnapshot(serverNotesSnapshot(serverSql))

				yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "Local note",
						content: "from client",
						user_id: "user-1",
						timestamp: 1100
					})
				)
				const pendingBefore = yield* clientA.actionRecordRepo.allUnsynced()
				expect(pendingBefore.length).toBeGreaterThan(0)

				yield* clientA.syncService.hardResync()

				const pendingAfter = yield* clientA.actionRecordRepo.allUnsynced()
				expect(pendingAfter.length).toBe(0)

				const serverNoteOnA = yield* clientA.noteRepo.findById(serverNote.id)
				expect(serverNoteOnA._tag).toBe("Some")
				if (serverNoteOnA._tag === "Some") {
					expect(serverNoteOnA.value.content).toBe("from server")
				}

				const localNotes = yield* clientA.noteRepo.findByTitle("Local note")
				expect(localNotes.length).toBe(0)

				const lastSeen = yield* clientA.clockService.getLastSeenServerIngestId
				expect(lastSeen).toBeGreaterThan(0)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)

	it.scoped(
		"rebase preserves pending action ids and re-applies them on a fresh snapshot",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)
				yield* clientA.syncNetworkServiceTestHelpers.setBootstrapSnapshot(serverNotesSnapshot(serverSql))

				const { result: note } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "A1",
						content: "base",
						user_id: "user-1",
						timestamp: 1000
					})
				)
				yield* clientA.syncService.executeAction(
					clientA.testHelpers.updateContentAction({ id: note.id, content: "updated", timestamp: 1100 })
				)

				const pendingBefore = yield* clientA.actionRecordRepo.allUnsynced()
				expect(pendingBefore.length).toBe(2)
				const pendingIdsBefore = pendingBefore.map((a) => a.id)

				yield* clientA.syncService.rebase()

				const noteAfter = yield* clientA.noteRepo.findById(note.id)
				expect(noteAfter._tag).toBe("Some")
				if (noteAfter._tag === "Some") {
					expect(noteAfter.value.content).toBe("updated")
				}

				const pendingAfter = yield* clientA.actionRecordRepo.allUnsynced()
				expect(pendingAfter.map((a) => a.id)).toEqual(pendingIdsBefore)

				const exit = yield* clientA.syncService.performSync().pipe(Effect.exit)
				expect(exit._tag).toBe("Success")

				const serverContent = yield* serverSql<{ readonly content: string }>`
					SELECT content FROM notes WHERE id = ${note.id}
				`
				expect(serverContent[0]?.content).toBe("updated")
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
