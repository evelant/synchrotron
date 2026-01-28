import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { CorrectionActionTag } from "@synchrotron/sync-core/SyncActionTags"
import { Effect, Option } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

const waitForNextMillisecond = Effect.sync(() => {
	const start = Date.now()
	while (Date.now() <= start) {
		// busy-wait: HLC uses Date.now(), not Effect TestClock
	}
})

describe("Shared-field overwrite convergence", () => {
	it.scoped(
		"converges to the last CORRECTION overwrite in canonical order",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const source = yield* createTestClient("source", serverSql).pipe(Effect.orDie)
				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)
				const clientB = yield* createTestClient("clientB", serverSql).pipe(Effect.orDie)

				const { result: note } = yield* source.syncService.executeAction(
					source.testHelpers.createNoteAction({
						title: "Shared-field overwrite",
						content: "Initial",
						user_id: "user-1",
						timestamp: 1000
					})
				)

				yield* source.syncService.performSync()
				yield* clientA.syncService.performSync()
				yield* clientB.syncService.performSync()

				yield* source.syncService.executeAction(
					source.testHelpers.clientSpecificContentAction({
						id: note.id,
						baseContent: "Base",
						timestamp: 2000
					})
				)
				yield* source.syncService.performSync()

				// Client A applies the base action and emits an overwriting CORRECTION ("Base-clientA"),
				// then uploads it.
				yield* clientA.syncService.performSync()
				const noteAAfterBase = yield* clientA.noteRepo.findById(note.id)
				expect(noteAAfterBase.pipe(Option.map((n) => n.content)).pipe(Option.getOrThrow)).toBe(
					"Base-clientA"
				)
				yield* clientA.syncService.performSync()

				yield* waitForNextMillisecond

				// Client B receives the base action and A's CORRECTION in one batch, computes a different
				// shared-field value ("Base-clientB"), and emits a second overwriting CORRECTION.
				yield* clientB.syncService.performSync()
				const correctionActionsOnB = yield* clientB.actionRecordRepo.findByTag(CorrectionActionTag)
				// B should have both the received CORRECTION from A and its own newly-emitted CORRECTION.
				expect(correctionActionsOnB.length).toBe(2)
				const localCorrectionOnB = correctionActionsOnB.find((a) => a.client_id === "clientB")
				expect(localCorrectionOnB?.synced).toBe(true)

				// Client A fast-forwards the later CORRECTION (no replay of the underlying action) and converges.
				yield* clientA.syncService.performSync()
				const noteAAfterB = yield* clientA.noteRepo.findById(note.id)
				expect(noteAAfterB.pipe(Option.map((n) => n.content)).pipe(Option.getOrThrow)).toBe(
					"Base-clientB"
				)

				// A subsequent sync pass without new inputs does not emit additional CORRECTION.
				yield* clientA.syncService.performSync()
				yield* clientB.syncService.performSync()
				const correctionCountA = (yield* clientA.actionRecordRepo.findByTag(CorrectionActionTag))
					.length
				const correctionCountB = (yield* clientB.actionRecordRepo.findByTag(CorrectionActionTag))
					.length
				expect(correctionCountA).toBe(2)
				expect(correctionCountB).toBe(2)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
