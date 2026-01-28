import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { CorrectionActionTag } from "@synchrotron/sync-core/SyncActionTags"
import { Effect } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("Unknown remote actions", () => {
	it.scoped(
		"fails atomically on unknown action tags (no partial apply, no persisted CORRECTION placeholder)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const source = yield* createTestClient("source", serverSql).pipe(Effect.orDie)
				const receiver = yield* createTestClient("receiver", serverSql).pipe(Effect.orDie)

				const { result: note, actionRecord: createAction } =
					yield* source.syncService.executeAction(
						source.testHelpers.createNoteAction({
							title: "Unknown-action atomicity",
							content: "",
							user_id: "user-1",
							timestamp: 1000
						})
					)
				yield* source.syncService.performSync()

				const { actionRecord: updateAction } = yield* source.syncService.executeAction(
					source.testHelpers.updateTitleAction({
						id: note.id,
						title: "Updated",
						timestamp: 2000
					})
				)
				yield* source.syncService.performSync()

				// Simulate a client that doesn't know how to replay a remote action tag.
				yield* serverSql`UPDATE action_records SET _tag = ${"test-unknown-action"} WHERE id = ${updateAction.id}`

				const exit = yield* receiver.syncService.performSync().pipe(Effect.exit)
				expect(exit._tag).toBe("Failure")

				// The apply batch should be transactional: the earlier known action must not be partially applied.
				const noteOnReceiver = yield* receiver.noteRepo.findById(note.id)
				expect(noteOnReceiver._tag).toBe("None")

				// The per-batch placeholder CORRECTION action should not be persisted on failure.
				const correctionActions = yield* receiver.actionRecordRepo.findByTag(CorrectionActionTag)
				expect(correctionActions.length).toBe(0)

				expect(yield* receiver.actionRecordRepo.isLocallyApplied(createAction.id)).toBe(false)
				expect(yield* receiver.actionRecordRepo.isLocallyApplied(updateAction.id)).toBe(false)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
