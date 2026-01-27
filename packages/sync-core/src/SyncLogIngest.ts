import type { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { ActionModifiedRow, ActionRecord } from "./models"

export interface RemoteSyncLogBatch {
	readonly actions: ReadonlyArray<ActionRecord>
	readonly modifiedRows: ReadonlyArray<ActionModifiedRow>
}

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

const bindJson = (sql: SqlClient.SqlClient, value: unknown) => {
	if (hasSqlJson(sql)) {
		// Avoid `JSON.stringify` throwing on BigInt, and avoid drivers encoding BigInt implicitly.
		const normalized = JSON.parse(JSON.stringify(value, bigintJsonReplacer)) as unknown
		return sql.json(normalized)
	}
	// SQLite stores JSON as TEXT.
	return JSON.stringify(value, bigintJsonReplacer)
}

/**
 * Persist a batch of remote sync-log rows into the local ingress tables.
 *
 * This is intentionally idempotent (duplicates are safe) and "upgrade-safe" for
 * rows that may already exist locally (e.g. a local action later received back
 * from the server via Electric).
 */
export const ingestRemoteSyncLogBatch = (sql: SqlClient.SqlClient, batch: RemoteSyncLogBatch) =>
	Effect.gen(function* () {
		if (batch.actions.length === 0 && batch.modifiedRows.length === 0) return

		for (const action of batch.actions) {
			yield* sql`
				INSERT INTO action_records ${sql.insert({
					server_ingest_id: action.server_ingest_id,
					id: action.id,
					user_id: action.user_id,
					_tag: action._tag,
					client_id: action.client_id,
					transaction_id: action.transaction_id,
					clock: bindJson(sql, action.clock),
					args: bindJson(sql, action.args),
					created_at: new Date(action.created_at).toISOString(),
					server_ingested_at: new Date(action.server_ingested_at).toISOString(),
					synced: 1
				})}
				ON CONFLICT (id) DO UPDATE SET
					-- Upgrade local rows when the server has accepted them.
					server_ingest_id = COALESCE(action_records.server_ingest_id, excluded.server_ingest_id),
					user_id = COALESCE(action_records.user_id, excluded.user_id),
					server_ingested_at = excluded.server_ingested_at,
					synced = 1
			`
		}

		for (const row of batch.modifiedRows) {
			yield* sql`
				INSERT INTO action_modified_rows ${sql.insert({
					id: row.id,
					table_name: row.table_name,
					row_id: row.row_id,
					action_record_id: row.action_record_id,
					audience_key: row.audience_key,
					operation: row.operation,
					forward_patches: bindJson(sql, row.forward_patches),
					reverse_patches: bindJson(sql, row.reverse_patches),
					sequence: row.sequence
				})}
				ON CONFLICT (id) DO NOTHING
			`
		}
	}).pipe(sql.withTransaction)
