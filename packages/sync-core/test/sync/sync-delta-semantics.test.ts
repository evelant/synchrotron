import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("SYNC delta semantics", () => {
	it.scoped(
		"outgoing _InternalSyncApply is marked locally applied (rollback correctness)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient
				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)
				const clientB = yield* createTestClient("clientB", serverSql).pipe(Effect.orDie)

				const { result } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "Divergence Test",
						content: "Initial",
						user_id: "user1",
						timestamp: 1000
					})
				)
				const noteId = result.id

				yield* clientA.syncService.performSync()
				yield* clientB.syncService.performSync()

				yield* clientA.syncService.executeAction(
					clientA.testHelpers.conditionalUpdateAction({
						id: noteId,
						baseContent: "Base",
						conditionalSuffix: " Suffix",
						timestamp: 2000
					})
				)
				yield* clientA.syncService.performSync()

				yield* clientB.syncService.performSync()

				const syncActions = yield* clientB.actionRecordRepo.findByTag("_InternalSyncApply")
				expect(syncActions.length).toBe(1)
				const syncAction = syncActions[0]!

				const locallyApplied = yield* clientB.actionRecordRepo.isLocallyApplied(syncAction.id)
				expect(locallyApplied).toBe(true)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)

	it.scoped(
		"outgoing SYNC delta sorts after the base action it corrects",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient
				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)
				const clientB = yield* createTestClient("clientB", serverSql).pipe(Effect.orDie)

				const { result } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "Ordering Test",
						content: "Initial",
						user_id: "user1",
						timestamp: 1000
					})
				)
				const noteId = result.id

				yield* clientA.syncService.performSync()
				yield* clientB.syncService.performSync()

				const { actionRecord: baseAction } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.conditionalUpdateAction({
						id: noteId,
						baseContent: "Base",
						conditionalSuffix: " Suffix",
						timestamp: 2000
					})
				)
				yield* clientA.syncService.performSync()

				// Make the base action appear far in the future relative to clientB.
				const remoteFutureTimeMs = Date.now() + 24 * 60 * 60 * 1000
				yield* serverSql`UPDATE action_records SET clock = ${serverSql.json({
					...baseAction.clock,
					timestamp: remoteFutureTimeMs
				})} WHERE id = ${baseAction.id}`

				yield* clientB.syncService.performSync()

				const observedBase = yield* clientB.actionRecordRepo.findById(baseAction.id)
				expect(observedBase._tag).toBe("Some")
				if (observedBase._tag !== "Some") return

				const syncActions = yield* clientB.actionRecordRepo.findByTag("_InternalSyncApply")
				expect(syncActions.length).toBe(1)
				const syncAction = syncActions[0]!

				const ordering = clientB.clockService.compareClock(
					{ clock: syncAction.clock, clientId: syncAction.client_id, id: syncAction.id },
					{
						clock: observedBase.value.clock,
						clientId: observedBase.value.client_id,
						id: observedBase.value.id
					}
				)

				expect(ordering).toBeGreaterThan(0)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
