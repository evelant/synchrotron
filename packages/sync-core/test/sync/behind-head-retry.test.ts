import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import type { ActionRecord } from "@synchrotron/sync-core/models"
import { ActionModifiedRow } from "@synchrotron/sync-core/models"
import { Effect } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

const waitForNextMillisecond = Effect.sync(() => {
	const start = Date.now()
	while (Date.now() <= start) {
		// busy-wait: HLC uses Date.now(), not Effect TestClock
	}
})

describe("SyncService: behind-head retry", () => {
	it.scoped(
		"retries on SendLocalActionsBehindHead by re-fetching then re-sending",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)
				const clientB = yield* createTestClient("clientB", serverSql).pipe(Effect.orDie)

				// Seed a local pending action on clientA (will be uploaded after retry).
				yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "A1",
						content: "a",
						user_id: "user1"
					})
				)

				// Force B's action clock to be strictly later than A's clock to avoid reconciliation.
				yield* waitForNextMillisecond

				let fetchCallCount = 0
				const fetchOverride = Effect.gen(function* () {
					fetchCallCount += 1

					// Simulate the race: a remote action is ingested AFTER the client's fetch result is determined,
					// but BEFORE it uploads its pending actions.
					if (fetchCallCount === 1) {
						yield* clientB.syncService
							.executeAction(
								clientB.testHelpers.createNoteAction({
									title: "B1",
									content: "b",
									user_id: "user1"
								})
							)
							.pipe(Effect.orDie)
						yield* clientB.syncService.performSync().pipe(Effect.orDie)
						return { actions: [], modifiedRows: [] } as const
					}

					const actions = yield* serverSql<ActionRecord>`
						SELECT * FROM action_records
						WHERE client_id != ${clientA.clientId}
						ORDER BY server_ingest_id ASC, id ASC
					`.pipe(Effect.orDie)

					const modifiedRows =
						actions.length > 0
							? yield* serverSql<ActionModifiedRow>`
									SELECT *
									FROM action_modified_rows
									WHERE action_record_id IN ${serverSql.in(actions.map((a) => a.id))}
									ORDER BY action_record_id, sequence ASC, id ASC
								`.pipe(Effect.orDie)
							: ([] as const)

					return { actions, modifiedRows } as const
				})

				yield* clientA.syncNetworkServiceTestHelpers.setFetchResult(fetchOverride)

				yield* clientA.syncService.performSync()

				expect(fetchCallCount).toBeGreaterThanOrEqual(2)

				const serverCountRows = yield* serverSql<{ readonly count: number | string }>`
					SELECT count(*)::int as count
					FROM action_records
				`
				const serverCount =
					typeof serverCountRows[0]?.count === "number"
						? serverCountRows[0].count
						: Number(serverCountRows[0]?.count ?? 0)
				expect(serverCount).toBe(2)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		20_000
	)
})

