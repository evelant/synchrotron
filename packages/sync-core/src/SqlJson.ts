import type { SqlClient } from "@effect/sql"

type SqlJsonCapable = {
	readonly json: (value: unknown) => unknown
}

const hasSqlJson = (sql: SqlClient.SqlClient): sql is SqlClient.SqlClient & SqlJsonCapable => {
	const candidate = sql as unknown as Partial<SqlJsonCapable>
	return typeof candidate.json === "function"
}

const bigintJsonReplacer = (_key: string, value: unknown): unknown => {
	if (typeof value !== "bigint") return value
	const asNumber = Number(value)
	return Number.isSafeInteger(asNumber) && BigInt(asNumber) === value ? asNumber : value.toString()
}

// Some call paths accidentally double-encode JSON (e.g. `"\"{...}\""`). Unwrap a few layers.
const unwrapJsonString = (value: unknown, maxDepth = 3): unknown => {
	let current: unknown = value
	for (let depth = 0; depth < maxDepth; depth++) {
		if (typeof current !== "string") return current
		const trimmed = current.trim()
		if (trimmed.length === 0) return current
		try {
			current = JSON.parse(trimmed) as unknown
		} catch {
			return current
		}
	}
	return current
}

const toJsonSafeValue = (value: unknown): unknown =>
	JSON.parse(JSON.stringify(unwrapJsonString(value), bigintJsonReplacer)) as unknown

/**
 * Dialect-aware JSON parameter binding:
 *
 * - Postgres / PGlite: bind JSON as a proper JSON/JSONB fragment when available (`sql.json`),
 *   avoiding the “JSONB string vs JSON object” pitfall.
 * - SQLite: store JSON as TEXT (`JSON.stringify`).
 *
 * This helper also makes values JSON-safe (BigInt-safe) and unwraps a few layers of accidental
 * double-encoding.
 */
export const bindJsonParam = (sql: SqlClient.SqlClient, value: unknown): unknown => {
	const normalized = toJsonSafeValue(value)
	if (hasSqlJson(sql)) return sql.json(normalized)
	return JSON.stringify(normalized)
}
