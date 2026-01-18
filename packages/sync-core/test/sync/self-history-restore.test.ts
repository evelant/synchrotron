import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import type { ActionRecord } from "@synchrotron/sync-core/models"
import { Effect } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("Client bootstrap restore", () => {
	it.scoped(
		"restores previously-synced self actions after local DB reset (same clientId)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const writer = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)
				const { result: note, actionRecord } = yield* writer.syncService.executeAction(
					writer.testHelpers.createNoteAction({
						title: "Self action note",
						content: "Hello",
						user_id: "user-1",
						timestamp: 1000
					})
				)
				yield* writer.syncService.performSync()

				const [serverAction] = yield* serverSql<ActionRecord>`
					SELECT * FROM action_records WHERE id = ${actionRecord.id}
				`
				expect(serverAction).toBeTruthy()
				if (!serverAction) return

				// Simulate "local DB cleared but identity persisted": new local DB, same clientId.
				const restored = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)

				const noteBefore = yield* restored.noteRepo.findById(note.id)
				expect(noteBefore._tag).toBe("None")

				yield* restored.syncService.performSync()

				const noteAfter = yield* restored.noteRepo.findById(note.id)
				expect(noteAfter._tag).toBe("Some")
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
