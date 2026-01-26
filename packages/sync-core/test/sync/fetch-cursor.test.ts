import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import type { ActionRecord } from "@synchrotron/sync-core/models"
import { Effect } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

const waitForNextMillisecond = Effect.sync(() => {
	const start = Date.now()
	while (Date.now() <= start) {
		// busy-wait: HLC uses Date.now(), not Effect TestClock
	}
})

describe("Reliable fetch cursor (server_ingest_id)", () => {
	it.scoped(
		"fetches late-arriving actions even if their HLC is older than last_synced_clock",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)
				const clientB = yield* createTestClient("clientB", serverSql).pipe(Effect.orDie)
				const clientC = yield* createTestClient("clientC", serverSql).pipe(Effect.orDie)

				// Seed the server with a remote action so clientA advances its ingestion cursor.
				yield* clientC.syncService.executeAction(
					clientC.testHelpers.createNoteAction({
						title: "C1",
						content: "seed",
						user_id: "user1"
					})
				)
				yield* clientC.syncService.performSync()

				yield* clientA.syncService.performSync()
				const lastSeenAfterC = yield* clientA.clockState.getLastSeenServerIngestId
				expect(lastSeenAfterC).toBeGreaterThan(0)

				// Create an action on clientB but don't upload it yet (offline / delayed upload).
				const { result: noteBOld, actionRecord: actionBOld } =
					yield* clientB.syncService.executeAction(
						clientB.testHelpers.createNoteAction({
							title: "B-old",
							content: "late arrival",
							user_id: "user1"
						})
					)

				// Move time forward so clientA's last_synced_clock is strictly newer than B's offline action clock.
				yield* waitForNextMillisecond

				// Advance clientA's last_synced_clock by syncing a local action after B's offline action.
				yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "A1",
						content: "advance watermark",
						user_id: "user1"
					})
				)
				yield* clientA.syncService.performSync()

				const lastSyncedClock = yield* clientA.clockState.getLastSyncedClock
				expect(actionBOld.clock.timestamp).toBeLessThan(lastSyncedClock.timestamp)

				const compare = yield* serverSql<{ result: number }>`
							SELECT compare_hlc(${serverSql.json(actionBOld.clock)}, ${serverSql.json(lastSyncedClock)}) as result
						`
				expect(compare[0]?.result).toBeLessThan(0)

				// Upload the offline action late (server assigns a new server_ingest_id).
				yield* clientB.syncService.performSync()

				const serverRecordForBOld = yield* serverSql<ActionRecord>`
						SELECT * FROM action_records WHERE id = ${actionBOld.id}
					`
				expect(serverRecordForBOld.length).toBe(1)
				const serverBOld = serverRecordForBOld[0]!
				expect(serverBOld.server_ingest_id).toBeGreaterThan(lastSeenAfterC)
				expect(serverBOld.clock.timestamp).toBe(actionBOld.clock.timestamp)

				const serverCompareAfterIngest = yield* serverSql<{ result: number }>`
						SELECT compare_hlc(${serverSql.json(serverBOld.clock)}, ${serverSql.json(lastSyncedClock)}) as result
					`
				expect(serverCompareAfterIngest[0]?.result).toBeLessThan(0)

				// ClientA should still fetch it (by server_ingest_id), even though its replay clock is older.
				const appliedOnA = yield* clientA.syncService.performSync()
				const fetchedBOld = appliedOnA.find((a) => a.id === actionBOld.id)
				expect(fetchedBOld?.clock.timestamp).toBe(actionBOld.clock.timestamp)

				const noteOnA = yield* clientA.noteRepo.findById(noteBOld.id)
				expect(noteOnA._tag).toBe("Some")

				const lastSeenAfterB = yield* clientA.clockState.getLastSeenServerIngestId
				expect(lastSeenAfterB).toBeGreaterThan(lastSeenAfterC)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		20_000
	)
})
