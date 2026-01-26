import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("Ingest/apply idempotency", () => {
	it.scoped(
		"re-fetching already-applied remote actions does not re-apply them (cursor reset)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const remote = yield* createTestClient("remote", serverSql).pipe(Effect.orDie)
				const receiver = yield* createTestClient("receiver", serverSql).pipe(Effect.orDie)

				const { result: note, actionRecord: createAction } =
					yield* remote.syncService.executeAction(
						remote.testHelpers.createNoteAction({
							title: "Idempotency note",
							content: "",
							user_id: "user-1",
							timestamp: 1000
						})
					)

				yield* remote.syncService.performSync()

				yield* receiver.syncService.performSync()
				const noteAfterFirstSync = yield* receiver.noteRepo.findById(note.id)
				expect(noteAfterFirstSync._tag).toBe("Some")

				const alreadyApplied = yield* receiver.actionRecordRepo.isLocallyApplied(createAction.id)
				expect(alreadyApplied).toBe(true)

				// Simulate a crash/restart where the ingestion cursor wasn't persisted, but the DB state was.
				yield* receiver.rawSql`
					UPDATE client_sync_status
					SET last_seen_server_ingest_id = 0
					WHERE client_id = ${receiver.clientId}
				`

				// Desired behavior: re-fetch should be a no-op (skip already-applied actions),
				// not a second execution of the action logic.
				yield* receiver.syncService.performSync()

				const noteAfterSecondSync = yield* receiver.noteRepo.findById(note.id)
				expect(Option.isSome(noteAfterSecondSync)).toBe(true)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)

	it.scoped(
		"re-applying the same received _InternalSyncApply does not error or create new outgoing SYNC",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)
				const clientB = yield* createTestClient("clientB", serverSql).pipe(Effect.orDie)
				const clientC = yield* createTestClient("clientC", serverSql).pipe(Effect.orDie)

				const { result } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "Divergence base",
						content: "Initial",
						user_id: "user1",
						timestamp: 1000
					})
				)
				const noteId = result.id

				yield* clientA.syncService.performSync()
				yield* clientB.syncService.performSync()
				yield* clientC.syncService.performSync()

				const { actionRecord: baseAction } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.conditionalUpdateAction({
						id: noteId,
						baseContent: "Base",
						conditionalSuffix: " Suffix",
						timestamp: 2000
					})
				)
				yield* clientA.syncService.performSync()

				yield* clientB.syncService.performSync()
				const syncActionsB = yield* clientB.actionRecordRepo.findByTag("_InternalSyncApply")
				expect(syncActionsB.length).toBe(1)
				const syncActionB = syncActionsB[0]!

				// Send SYNC delta to server.
				yield* clientB.syncService.performSync()

				// First apply on C.
				yield* clientC.syncService.performSync()
				const syncActionsC = yield* clientC.actionRecordRepo.findByTag("_InternalSyncApply")
				expect(syncActionsC.length).toBe(1)
				expect(syncActionsC[0]!.id).toBe(syncActionB.id)

				const baseIngestId = (yield* serverSql<{ server_ingest_id: number }>`
						SELECT server_ingest_id
						FROM action_records
						WHERE id = ${baseAction.id}
					`)[0]?.server_ingest_id
				expect(baseIngestId).toBeDefined()
				if (baseIngestId === undefined) return

				// Force C to re-fetch the SYNC action (but not the earlier actions).
				yield* clientC.rawSql`
					UPDATE client_sync_status
					SET last_seen_server_ingest_id = ${baseIngestId}
					WHERE client_id = ${clientC.clientId}
				`

				yield* clientC.syncService.performSync()

				// Desired behavior: no outgoing placeholder SYNC is kept.
				const unsyncedAfter = yield* clientC.actionRecordRepo.allUnsynced()
				expect(unsyncedAfter.length).toBe(0)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
