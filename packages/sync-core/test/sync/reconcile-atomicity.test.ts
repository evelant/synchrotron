import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { RollbackActionTag } from "@synchrotron/sync-core/SyncActionTags"
import { Effect } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("Reconcile atomicity", () => {
	it.scoped(
		"fails atomically when replay fails during reconcile (no persisted rollback, no rollback marker)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const source = yield* createTestClient("source", serverSql).pipe(Effect.orDie)
				const receiver = yield* createTestClient("receiver", serverSql).pipe(Effect.orDie)

				// Create a remote action first so it sorts before the receiver's local pending action.
				const { actionRecord: remoteCreateAction } = yield* source.syncService.executeAction(
					source.testHelpers.createNoteAction({
						title: "Remote note (will be unknown on receiver)",
						content: "",
						user_id: "user-1",
						timestamp: 1000
					})
				)
				yield* source.syncService.performSync()

				// Now create a local pending action on the receiver without syncing.
				const { result: localNote, actionRecord: localCreateAction } =
					yield* receiver.syncService.executeAction(
						receiver.testHelpers.createNoteAction({
							title: "Receiver local note",
							content: "",
							user_id: "user-1",
							timestamp: 2000
						})
					)

				const noteBefore = yield* receiver.noteRepo.findById(localNote.id)
				expect(noteBefore._tag).toBe("Some")
				expect(yield* receiver.actionRecordRepo.isLocallyApplied(localCreateAction.id)).toBe(true)

				// Simulate a receiver that doesn't know how to replay the remote action tag.
				yield* serverSql`UPDATE action_records SET _tag = ${"test-unknown-action"} WHERE id = ${remoteCreateAction.id}`

				const exit = yield* receiver.syncService.performSync().pipe(Effect.exit)
				expect(exit._tag).toBe("Failure")

				// Reconciliation should be atomic: receiver-local state must remain intact after failure.
				const noteAfter = yield* receiver.noteRepo.findById(localNote.id)
				expect(noteAfter._tag).toBe("Some")

				// The reconcile rollback marker should not be persisted on failure.
				const rollbackActions = yield* receiver.actionRecordRepo.findByTag(RollbackActionTag)
				expect(rollbackActions.length).toBe(0)

				// Local pending work should remain applied and remote unknown work should not be applied.
				expect(yield* receiver.actionRecordRepo.isLocallyApplied(localCreateAction.id)).toBe(true)
				expect(yield* receiver.actionRecordRepo.isLocallyApplied(remoteCreateAction.id)).toBe(false)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})

