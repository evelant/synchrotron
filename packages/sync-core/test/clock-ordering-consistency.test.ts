import { PgliteClient } from "@effect/sql-pglite"
import { describe, it } from "@effect/vitest"
import { ClockService } from "@synchrotron/sync-core/ClockService"
import * as HLC from "@synchrotron/sync-core/HLC"
import { Effect } from "effect"
import { expect } from "vitest"
import { makeTestLayers } from "./helpers/TestLayers"

describe("Clock ordering consistency", () => {
	it.scoped("TS action ordering matches DB ordering key columns", () =>
		Effect.gen(function* () {
			const sql = yield* PgliteClient.PgliteClient
			const clockService = yield* ClockService

			const actions = [
				{
					id: "id-1",
					client_id: "a",
					clock: HLC.make({ timestamp: 999, vector: { a: 2 } })
				},
				{
					id: "id-5",
					client_id: "a",
					clock: HLC.make({ timestamp: 1000, vector: {} })
				},
				{
					id: "id-3",
					client_id: "a",
					clock: HLC.make({ timestamp: 1000, vector: { a: 5 } })
				},
				{
					id: "id-4",
					client_id: "a",
					clock: HLC.make({ timestamp: 1000, vector: { a: 5 } })
				},
				{
					id: "id-2",
					client_id: "b",
					clock: HLC.make({ timestamp: 1000, vector: { b: 5 } })
				}
			] as const

			for (const action of actions) {
				yield* sql`
					INSERT INTO action_records (id, _tag, client_id, transaction_id, clock, args)
					VALUES (
						${action.id},
						'test',
						${action.client_id},
						1,
						${sql.json(action.clock)},
						${sql.json({ timestamp: action.clock.timestamp })}
					)
				`
			}

			const dbOrdered = yield* sql<{ id: string }>`
				SELECT id FROM action_records
				ORDER BY clock_time_ms ASC, clock_counter ASC, client_id ASC, id ASC
			`

			const tsOrdered = [...actions]
				.sort((a, b) =>
					clockService.compareClock(
						{ clock: a.clock, clientId: a.client_id, id: a.id },
						{ clock: b.clock, clientId: b.client_id, id: b.id }
					)
				)
				.map((a) => a.id)

			expect(dbOrdered.map((r) => r.id)).toEqual(tsOrdered)
		}).pipe(Effect.provide(makeTestLayers("server")))
	)
})
