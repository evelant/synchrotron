import { SqlClient } from "@effect/sql"
import type * as HLC from "@synchrotron/sync-core/HLC"
import { Effect, Schema } from "effect"

export class ServerMetaError extends Schema.TaggedError<ServerMetaError>()("ServerMetaError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Unknown)
}) {}

const parseJson = (value: unknown): unknown => {
	if (typeof value !== "string") return value
	try {
		return JSON.parse(value)
	} catch {
		return value
	}
}

const parseVector = (value: unknown): Record<string, number> => {
	if (typeof value !== "object" || value === null) return {}
	const out: Record<string, number> = {}
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw === "number") out[key] = raw
		else if (typeof raw === "bigint") out[key] = Number(raw)
		else if (typeof raw === "string") {
			const parsed = Number(raw)
			if (Number.isFinite(parsed)) out[key] = parsed
		}
	}
	return out
}

const parseClock = (value: unknown): HLC.HLC => {
	const parsed = parseJson(value)
	if (typeof parsed === "object" && parsed !== null) {
		const obj = parsed as { readonly timestamp?: unknown; readonly vector?: unknown }
		return {
			timestamp: typeof obj.timestamp === "number" ? obj.timestamp : Number(obj.timestamp ?? 0),
			vector: parseVector(obj.vector)
		}
	}
	return { timestamp: 0, vector: {} }
}

/**
 * Server-side sync metadata helpers.
 *
 * - `serverEpoch` is a global generation token used to detect hard history discontinuities.
 * - `serverClock` is derived from the latest visible action record (RLS-filtered per request).
 */
export class ServerMetaService extends Effect.Service<ServerMetaService>()("ServerMetaService", {
	effect: Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient

		const ensureServerEpoch = () =>
			Effect.gen(function* () {
				const rows = yield* sql<{ readonly server_epoch: string }>`
					SELECT server_epoch::text AS server_epoch
					FROM sync_server_meta
					WHERE id = 1
				`
				const existing = rows[0]?.server_epoch
				if (existing && existing.length > 0) return existing

				const inserted = yield* sql<{ readonly server_epoch: string }>`
					INSERT INTO sync_server_meta (id) VALUES (1)
					ON CONFLICT (id) DO UPDATE SET id = excluded.id
					RETURNING server_epoch::text AS server_epoch
				`
				const epoch = inserted[0]?.server_epoch
				if (epoch && epoch.length > 0) return epoch

				return crypto.randomUUID()
			})

		const getServerClock = () =>
			Effect.gen(function* () {
				const rows = yield* sql<{ readonly clock: unknown }>`
					SELECT clock
					FROM action_records
					ORDER BY clock_time_ms DESC, clock_counter DESC, client_id DESC, id DESC
					LIMIT 1
				`
				return parseClock(rows[0]?.clock)
			})

		return { ensureServerEpoch, getServerClock } as const
	})
}) {}
