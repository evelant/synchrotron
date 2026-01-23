import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("Server upload gating (client must be at HEAD)", () => {
	it.scoped(
		"does not reject sequential uploads from the same client (basis excludes own actions)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)

				yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "A1",
						content: "",
						user_id: "user-1",
						timestamp: 1000
					})
				)
				yield* clientA.syncService.performSync()

				// Client A hasn't fetched anything, so its basisServerIngestId is still its last seen
				// remote ingest cursor (likely 0). The server must not treat A's own ingested actions as
				// "unseen head" for A, since the client can't know server_ingest_id for its uploads.
				yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "A2",
						content: "",
						user_id: "user-1",
						timestamp: 2000
					})
				)
				const exit = yield* clientA.syncService.performSync().pipe(Effect.exit)
				expect(exit._tag).toBe("Success")

				const count = yield* serverSql<{ count: number }>`
					SELECT count(*)::int as count FROM notes WHERE user_id = ${"user-1"}
				`
				expect(count[0]?.count).toBe(2)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)

	it.scoped(
		"rejects upload when the client is behind server_ingest_id head",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const clientB = yield* createTestClient("clientB", serverSql).pipe(Effect.orDie)
				yield* clientB.syncService.executeAction(
					clientB.testHelpers.createNoteAction({
						title: "Server note",
						content: "",
						user_id: "user-1",
						timestamp: 1000
					})
				)
				yield* clientB.syncService.performSync()

				// Client A is misconfigured to "miss" remote actions (fetch returns empty), so it will try to
				// upload while still behind the server ingestion head.
				const clientA = yield* createTestClient("clientA", serverSql, {
					initialState: {
						fetchResult: Effect.gen(function* () {
							const epochRows = yield* serverSql<{ readonly server_epoch: string }>`
								SELECT server_epoch::text AS server_epoch
								FROM sync_server_meta
								WHERE id = 1
							`.pipe(Effect.orDie)
							const serverEpoch = epochRows[0]?.server_epoch ?? "test-epoch"

							const minRows = yield* serverSql<{
								readonly min_server_ingest_id: number | string | bigint | null
							}>`
								SELECT COALESCE(MIN(server_ingest_id), 0) as min_server_ingest_id
								FROM action_records
							`.pipe(Effect.orDie)
							const minRetainedServerIngestId = Number(minRows[0]?.min_server_ingest_id ?? 0)

							return { serverEpoch, minRetainedServerIngestId, actions: [], modifiedRows: [] } as const
						})
					}
				}).pipe(Effect.orDie)

				yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "Client note",
						content: "",
						user_id: "user-1",
						timestamp: 1100
					})
				)

				const exit = yield* clientA.syncService.performSync().pipe(Effect.exit)
				expect(exit._tag).toBe("Failure")
				if (exit._tag === "Failure") {
					expect(Cause.pretty(exit.cause)).toContain("behind the server ingestion head")
				}
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)

	it.scoped(
		"recovers after rejection by fetching+reconciling then retrying upload",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const clientB = yield* createTestClient("clientB", serverSql).pipe(Effect.orDie)
				yield* clientB.syncService.executeAction(
					clientB.testHelpers.createNoteAction({
						title: "Server note",
						content: "",
						user_id: "user-1",
						timestamp: 1000
					})
				)
				yield* clientB.syncService.performSync()

				const clientA = yield* createTestClient("clientA", serverSql, {
					initialState: {
						fetchResult: Effect.gen(function* () {
							const epochRows = yield* serverSql<{ readonly server_epoch: string }>`
								SELECT server_epoch::text AS server_epoch
								FROM sync_server_meta
								WHERE id = 1
							`.pipe(Effect.orDie)
							const serverEpoch = epochRows[0]?.server_epoch ?? "test-epoch"

							const minRows = yield* serverSql<{
								readonly min_server_ingest_id: number | string | bigint | null
							}>`
								SELECT COALESCE(MIN(server_ingest_id), 0) as min_server_ingest_id
								FROM action_records
							`.pipe(Effect.orDie)
							const minRetainedServerIngestId = Number(minRows[0]?.min_server_ingest_id ?? 0)

							return { serverEpoch, minRetainedServerIngestId, actions: [], modifiedRows: [] } as const
						})
					}
				}).pipe(Effect.orDie)

				yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "Client note",
						content: "",
						user_id: "user-1",
						timestamp: 1100
					})
				)

				const firstAttempt = yield* clientA.syncService.performSync().pipe(Effect.exit)
				expect(firstAttempt._tag).toBe("Failure")
				if (firstAttempt._tag === "Failure") {
					expect(Cause.pretty(firstAttempt.cause)).toContain("behind the server ingestion head")
				}

				// Fix the fetch path (client is no longer "missing" remote actions), then retry:
				// - fetch remote actions
				// - reconcile locally if needed
				// - upload pending actions while at HEAD
				yield* clientA.syncNetworkServiceTestHelpers.setFetchResult(undefined)

				const retryAttempt = yield* clientA.syncService.performSync().pipe(Effect.exit)
				expect(retryAttempt._tag).toBe("Success")

				const titles = yield* serverSql<{ title: string }>`
					SELECT title FROM notes WHERE user_id = ${"user-1"} ORDER BY title ASC
				`
				expect(titles.map((t) => t.title)).toEqual(["Client note", "Server note"])
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
