import { SqlClient, type SqlError } from "@effect/sql"
import type { Fragment, Primitive } from "@effect/sql/Statement"
import { Effect } from "effect"
import type { ActionModifiedRow } from "./models"

type PatchSqlValue = Primitive | Fragment

const isPrimitive = (value: unknown): value is Primitive =>
	value === null ||
	typeof value === "string" ||
	typeof value === "number" ||
	typeof value === "bigint" ||
	typeof value === "boolean" ||
	value instanceof Date ||
	value instanceof Int8Array ||
	value instanceof Uint8Array

const toPatchSqlValue = (sql: SqlClient.SqlClient, value: unknown): PatchSqlValue => {
	// SQLite drivers generally cannot bind booleans or Date objects directly.
	// Convert them into portable primitives.
	if (typeof value === "boolean") {
		return sql.onDialectOrElse({
			pg: () => value,
			sqlite: () => (value ? 1 : 0),
			orElse: () => value
		})
	}

	if (value instanceof Date) {
		return sql.onDialectOrElse({
			pg: () => value,
			sqlite: () => value.toISOString(),
			orElse: () => value
		})
	}

	if (isPrimitive(value)) return value

	if (Array.isArray(value)) {
		if (value.every(isPrimitive)) {
			return sql.onDialectOrElse({
				pg: () => {
					const array = (sql as any).array as undefined | ((a: ReadonlyArray<Primitive>) => Fragment)
					if (!array) return JSON.stringify(value)
					return array(value)
				},
				// SQLite will store arrays as JSON text for now.
				sqlite: () => JSON.stringify(value),
				orElse: () => JSON.stringify(value)
			})
		}
		return JSON.stringify(value)
	}

	// Objects (JSON) are stored/transported as plain JS values in patches.
	return sql.onDialectOrElse({
		pg: () => {
			const json = (sql as any).json as undefined | ((v: unknown) => Fragment)
			if (!json) return JSON.stringify(value)
			return json(value)
		},
		// SQLite will store objects as JSON text for now.
		sqlite: () => JSON.stringify(value),
		orElse: () => JSON.stringify(value)
	})
}

const toPatchSqlRecord = (sql: SqlClient.SqlClient, patches: Record<string, unknown>) => {
	const out: Record<string, PatchSqlValue> = {}
	for (const [key, value] of Object.entries(patches)) {
		if (value === undefined) continue
		out[key] = toPatchSqlValue(sql, value)
	}
	return out
}

const insertIgnoreFragment = (sql: SqlClient.SqlClient) =>
	sql.onDialectOrElse({
		pg: () => sql` ON CONFLICT (id) DO NOTHING`,
		sqlite: () => sql` ON CONFLICT (id) DO NOTHING`,
		orElse: () => sql``
	})

const applyForwardAmr = (
	sql: SqlClient.SqlClient,
	amr: ActionModifiedRow
): Effect.Effect<void, SqlError.SqlError> =>
	Effect.gen(function* () {
		const table = sql(amr.table_name)

		if (amr.operation === "DELETE") {
			yield* sql`DELETE FROM ${table} WHERE id = ${amr.row_id}`
			return
		}

		if (amr.operation === "INSERT") {
			const patches = { ...amr.forward_patches }
			if (!Object.prototype.hasOwnProperty.call(patches, "id")) {
				patches["id"] = amr.row_id
			}
			yield* sql`
				INSERT INTO ${table} ${sql.insert(toPatchSqlRecord(sql, patches))}
				${insertIgnoreFragment(sql)}
			`
			return
		}

		const patches = { ...amr.forward_patches }
		delete patches["id"]
		if (Object.keys(patches).length === 0) return

		yield* sql`
			UPDATE ${table}
			SET ${sql.update(toPatchSqlRecord(sql, patches))}
			WHERE id = ${amr.row_id}
		`
	})

const applyReverseAmr = (
	sql: SqlClient.SqlClient,
	amr: ActionModifiedRow
): Effect.Effect<void, SqlError.SqlError> =>
	Effect.gen(function* () {
		const table = sql(amr.table_name)

		if (amr.operation === "INSERT") {
			// Reverse of INSERT is DELETE.
			yield* sql`DELETE FROM ${table} WHERE id = ${amr.row_id}`
			return
		}

		if (amr.operation === "DELETE") {
			// Reverse of DELETE is INSERT (restore the entire row).
			const patches = { ...amr.reverse_patches }
			if (!Object.prototype.hasOwnProperty.call(patches, "id")) {
				patches["id"] = amr.row_id
			}
			yield* sql`
				INSERT INTO ${table} ${sql.insert(toPatchSqlRecord(sql, patches))}
				${insertIgnoreFragment(sql)}
			`
			return
		}

		const patches = { ...amr.reverse_patches }
		delete patches["id"]
		if (Object.keys(patches).length === 0) return

		yield* sql`
			UPDATE ${table}
			SET ${sql.update(toPatchSqlRecord(sql, patches))}
			WHERE id = ${amr.row_id}
		`
	})

export const applyForwardAmrs = (
	amrs: readonly ActionModifiedRow[]
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		for (const amr of amrs) {
			yield* applyForwardAmr(sql, amr)
		}
	})

export const applyReverseAmrs = (
	amrs: readonly ActionModifiedRow[]
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		for (const amr of amrs) {
			yield* applyReverseAmr(sql, amr)
		}
	})
