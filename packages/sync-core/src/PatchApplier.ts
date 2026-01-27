import { SqlClient, type SqlError } from "@effect/sql"
import type { Fragment } from "@effect/sql/Statement"
import { Effect } from "effect"
import type { ActionModifiedRow } from "./models"
import { bindJsonParam } from "./SqlJson"

type PatchSqlValue = unknown | Fragment

type PatchDialect = "pg" | "sqlite" | "other"

const dialectOf = (sql: SqlClient.SqlClient): PatchDialect =>
	sql.onDialectOrElse({
		pg: () => "pg",
		sqlite: () => "sqlite",
		orElse: () => "other"
	})

// Note: Patch apply runs primarily for received SYNC actions (patch-only). Those are expected to be rare,
// but caching avoids repeated catalog/pragma lookups when a SYNC has many AMRs for the same table.
const shouldWriteAudienceKeyCache = new Map<string, boolean>()

const shouldWriteAudienceKey = (
	sql: SqlClient.SqlClient,
	tableName: string
): Effect.Effect<boolean, SqlError.SqlError> =>
	Effect.gen(function* () {
		const dialect = dialectOf(sql)
		const cacheKey = `${dialect}:${tableName}`
		if (shouldWriteAudienceKeyCache.has(cacheKey)) {
			return shouldWriteAudienceKeyCache.get(cacheKey)!
		}

		const shouldWrite = yield* Effect.gen(function* () {
			if (dialect === "pg") {
				const rows = yield* sql<{ generated: boolean | number }>`
					SELECT (attgenerated IS NOT NULL AND attgenerated <> '') AS generated
					FROM pg_attribute
					WHERE attrelid = to_regclass(${tableName})
						AND attname = 'audience_key'
						AND NOT attisdropped
					LIMIT 1
				`
				const generated = rows[0]?.generated
				const isGenerated = generated === true || generated === 1
				return rows.length > 0 && !isGenerated
			}

			if (dialect === "sqlite") {
				const rows = yield* sql<{ name: string; hidden?: number | null }>`
					SELECT name, hidden FROM pragma_table_xinfo(${tableName})
				`.pipe(
					Effect.catchAll(
						() =>
							sql<{ name: string; hidden?: number | null }>`
							SELECT name, 0 as hidden FROM pragma_table_info(${tableName})
						`
					)
				)
				const column = rows.find((r) => r.name.toLowerCase() === "audience_key")
				if (!column) return false

				// SQLite: pragma_table_xinfo.hidden:
				// - 0: normal
				// - 1: hidden
				// - 2+: generated / internal (treat as generated for write-avoidance)
				const hidden = column.hidden ?? 0
				const isGenerated = hidden >= 2
				return !isGenerated
			}

			return false
		})

		shouldWriteAudienceKeyCache.set(cacheKey, shouldWrite)
		return shouldWrite
	})

const isPrimitive = (value: unknown) =>
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
					const array = (
						sql as unknown as {
							readonly array?: (a: ReadonlyArray<unknown>) => Fragment
						}
					).array
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
	return bindJsonParam(sql, value)
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
		yield* Effect.logTrace("patch.applyForward.start", {
			amrId: amr.id,
			actionRecordId: amr.action_record_id,
			operation: amr.operation,
			table_name: amr.table_name,
			row_id: amr.row_id,
			forwardPatchKeyCount: Object.keys(amr.forward_patches).length
		})
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
			// audience_key is stripped out of JSON patches (stored on the AMR row instead). For tables
			// with a non-generated audience_key column, we must include it on INSERT so NOT NULL / RLS
			// checks can succeed.
			if (
				amr.audience_key &&
				!Object.prototype.hasOwnProperty.call(patches, "audience_key") &&
				(yield* shouldWriteAudienceKey(sql, amr.table_name))
			) {
				patches["audience_key"] = amr.audience_key
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
	}).pipe(
		Effect.annotateLogs({
			amrId: amr.id,
			operation: amr.operation,
			table_name: amr.table_name,
			row_id: amr.row_id
		}),
		Effect.withSpan("PatchApplier.applyForwardAmr", {
			attributes: { amrId: amr.id, operation: amr.operation, table_name: amr.table_name }
		})
	)

const applyReverseAmr = (
	sql: SqlClient.SqlClient,
	amr: ActionModifiedRow
): Effect.Effect<void, SqlError.SqlError> =>
	Effect.gen(function* () {
		yield* Effect.logTrace("patch.applyReverse.start", {
			amrId: amr.id,
			actionRecordId: amr.action_record_id,
			operation: amr.operation,
			table_name: amr.table_name,
			row_id: amr.row_id,
			reversePatchKeyCount: Object.keys(amr.reverse_patches).length
		})
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
			if (
				amr.audience_key &&
				!Object.prototype.hasOwnProperty.call(patches, "audience_key") &&
				(yield* shouldWriteAudienceKey(sql, amr.table_name))
			) {
				patches["audience_key"] = amr.audience_key
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
	}).pipe(
		Effect.annotateLogs({
			amrId: amr.id,
			operation: amr.operation,
			table_name: amr.table_name,
			row_id: amr.row_id
		}),
		Effect.withSpan("PatchApplier.applyReverseAmr", {
			attributes: { amrId: amr.id, operation: amr.operation, table_name: amr.table_name }
		})
	)

export const applyForwardAmrs = (
	amrs: readonly ActionModifiedRow[]
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		yield* Effect.logDebug("patch.applyForward.batch", { amrCount: amrs.length })
		for (const amr of amrs) {
			yield* applyForwardAmr(sql, amr)
		}
	}).pipe(
		Effect.withSpan("PatchApplier.applyForwardAmrs", { attributes: { amrCount: amrs.length } })
	)

export const applyReverseAmrs = (
	amrs: readonly ActionModifiedRow[]
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		yield* Effect.logDebug("patch.applyReverse.batch", { amrCount: amrs.length })
		for (const amr of amrs) {
			yield* applyReverseAmr(sql, amr)
		}
	}).pipe(
		Effect.withSpan("PatchApplier.applyReverseAmrs", { attributes: { amrCount: amrs.length } })
	)
