import type { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Canonical total order for `action_records`, expressed in terms of persisted order columns:
 *
 * `(clock_time_ms, clock_counter, client_id, id)`
 *
 * This is the same order described in `ClockOrder.ts`, but using the database columns directly so
 * both client and server can share rollback / late-arrival planning logic without reconstructing HLC
 * values (and without drifting over time).
 */
export type ActionLogOrderKey = {
	readonly timeMs: number
	readonly counter: number
	readonly clientId: string
	readonly id: string
}

/** Normalize SQL driver numeric shapes (`number | string | bigint`) into a JS number. */
export const normalizeSqlNumber = (value: unknown): number => {
	if (typeof value === "number") return value
	if (typeof value === "bigint") return Number(value)
	if (typeof value === "string") return Number(value)
	return Number(value)
}

/** Total order for `(clock_time_ms, clock_counter, client_id, id)` comparisons. */
export const compareActionLogOrderKey = (a: ActionLogOrderKey, b: ActionLogOrderKey): number => {
	if (a.timeMs !== b.timeMs) return a.timeMs < b.timeMs ? -1 : 1
	if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1
	if (a.clientId !== b.clientId) return a.clientId < b.clientId ? -1 : 1
	if (a.id !== b.id) return a.id < b.id ? -1 : 1
	return 0
}

type ActionLogOrderRow = {
	readonly id: string
	readonly clock_time_ms: unknown
	readonly clock_counter: unknown
	readonly client_id: string
}

export const actionLogOrderKeyFromRow = (row: ActionLogOrderRow): ActionLogOrderKey => ({
	timeMs: normalizeSqlNumber(row.clock_time_ms),
	counter: normalizeSqlNumber(row.clock_counter),
	clientId: row.client_id,
	id: row.id
})

const oldestByActionLogOrder = <Row extends ActionLogOrderRow>(
	rows: ReadonlyArray<Row>
): Row | undefined => {
	let oldest: Row | undefined
	for (const row of rows) {
		if (!oldest) {
			oldest = row
			continue
		}
		const cmp = compareActionLogOrderKey(
			actionLogOrderKeyFromRow(row),
			actionLogOrderKeyFromRow(oldest)
		)
		if (cmp < 0) oldest = row
	}
	return oldest
}

export const findPredecessorActionId = (sql: SqlClient.SqlClient, key: ActionLogOrderKey) =>
	sql<{ readonly id: string }>`
		SELECT id
		FROM action_records
		WHERE (clock_time_ms, clock_counter, client_id, id) < (
			${key.timeMs},
			${key.counter},
			${key.clientId},
			${key.id}
		)
		ORDER BY clock_time_ms DESC, clock_counter DESC, client_id DESC, id DESC
		LIMIT 1
	`.pipe(Effect.map((rows) => rows[0]?.id ?? null))

/**
 * Resolve a set of action IDs to:
 * - which IDs are missing from `action_records`
 * - the "oldest" existing action ID in canonical action-log order
 *
 * This is used when processing RollbackAction markers: multiple markers in a batch can target
 * different historical points; we deterministically pick the oldest target.
 */
export const resolveOldestExistingActionId = (deps: {
	readonly sql: SqlClient.SqlClient
	readonly ids: readonly string[]
}) =>
	Effect.gen(function* () {
		const { sql } = deps
		const uniqueIds = [...new Set(deps.ids.filter((id) => id.length > 0))]
		if (uniqueIds.length === 0) {
			return { oldestId: null as string | null, missingIds: [] as readonly string[] }
		}

		const rows = yield* sql<{
			readonly id: string
			readonly clock_time_ms: number | string | bigint
			readonly clock_counter: number | string | bigint
			readonly client_id: string
		}>`
			SELECT id, clock_time_ms, clock_counter, client_id
			FROM action_records
			WHERE id IN ${sql.in(uniqueIds)}
		`

		const foundIds = new Set(rows.map((row) => row.id))
		const missingIds = uniqueIds.filter((id) => !foundIds.has(id))
		const oldest = oldestByActionLogOrder(rows)
		return { oldestId: oldest?.id ?? null, missingIds }
	})
