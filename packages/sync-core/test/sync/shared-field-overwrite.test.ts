import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
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
		"converges to the last SYNC overwrite in canonical order",
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

				// Client A applies the base action and emits an overwriting SYNC ("Base-clientA"),
				// then uploads it.
				yield* clientA.syncService.performSync()
				const noteAAfterBase = yield* clientA.noteRepo.findById(note.id)
				expect(noteAAfterBase.pipe(Option.map((n) => n.content)).pipe(Option.getOrThrow)).toBe(
					"Base-clientA"
				)
				yield* clientA.syncService.performSync()

				yield* waitForNextMillisecond

				// Client B receives the base action and A's SYNC in one batch, computes a different
				// shared-field value ("Base-clientB"), and emits a second overwriting SYNC.
				yield* clientB.syncService.performSync()
				const syncActionsOnB = yield* clientB.actionRecordRepo.findByTag("_InternalSyncApply")
				// B should have both the received SYNC from A and its own newly-emitted SYNC.
				expect(syncActionsOnB.length).toBe(2)
				const localSyncOnB = syncActionsOnB.find((a) => a.client_id === "clientB")
				expect(localSyncOnB?.synced).toBe(true)

				// Client A fast-forwards the later SYNC (no replay of the underlying action) and converges.
				yield* clientA.syncService.performSync()
				const noteAAfterB = yield* clientA.noteRepo.findById(note.id)
				expect(noteAAfterB.pipe(Option.map((n) => n.content)).pipe(Option.getOrThrow)).toBe(
					"Base-clientB"
				)

				// A subsequent sync pass without new inputs does not emit additional SYNC.
				yield* clientA.syncService.performSync()
				yield* clientB.syncService.performSync()
				const syncCountA = (yield* clientA.actionRecordRepo.findByTag("_InternalSyncApply")).length
				const syncCountB = (yield* clientB.actionRecordRepo.findByTag("_InternalSyncApply")).length
				expect(syncCountA).toBe(2)
				expect(syncCountB).toBe(2)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
