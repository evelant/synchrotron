import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("Upload bookkeeping atomicity", () => {
	it.scoped(
		"rolls back markAsSynced when last_synced_clock update fails",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)

				const { result: note } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "Upload atomicity",
						content: "base",
						user_id: "user-1",
						timestamp: 1000
					})
				)
				yield* clientA.syncService.executeAction(
					clientA.testHelpers.updateContentAction({
						id: note.id,
						content: "updated",
						timestamp: 1100
					})
				)

				const pendingBefore = yield* clientA.actionRecordRepo.allUnsynced()
				expect(pendingBefore.length).toBe(2)
				const pendingIdsBefore = pendingBefore.map((a) => a.id)

				const setupTrigger = Effect.gen(function* () {
					yield* clientA.rawSql.unsafe(`
						CREATE OR REPLACE FUNCTION sync_test_fail_client_sync_status_update()
						RETURNS trigger AS $$
						BEGIN
							RAISE EXCEPTION 'sync_test_fail_client_sync_status_update';
						END;
						$$ LANGUAGE plpgsql;
					`)
					yield* clientA.rawSql.unsafe(
						`DROP TRIGGER IF EXISTS sync_test_fail_client_sync_status_update ON client_sync_status`
					)
					yield* clientA.rawSql.unsafe(`
						CREATE TRIGGER sync_test_fail_client_sync_status_update
						BEFORE UPDATE ON client_sync_status
						FOR EACH ROW EXECUTE FUNCTION sync_test_fail_client_sync_status_update();
					`)
				})

				const cleanupTrigger = Effect.gen(function* () {
					yield* clientA.rawSql
						.unsafe(
							`DROP TRIGGER IF EXISTS sync_test_fail_client_sync_status_update ON client_sync_status`
						)
						.pipe(Effect.catchAll(Effect.logError))
					yield* clientA.rawSql
						.unsafe(`DROP FUNCTION IF EXISTS sync_test_fail_client_sync_status_update()`)
						.pipe(Effect.catchAll(Effect.logError))
				})

				const exit = yield* Effect.acquireUseRelease(
					setupTrigger,
					() => clientA.syncService.performSync().pipe(Effect.exit),
					() => cleanupTrigger
				)
				expect(exit._tag).toBe("Failure")

				const pendingAfter = yield* clientA.actionRecordRepo.allUnsynced()
				expect(pendingAfter.map((a) => a.id)).toEqual(pendingIdsBefore)

				const syncedAfter = yield* clientA.actionRecordRepo.findBySynced(true)
				expect(syncedAfter.length).toBe(0)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
