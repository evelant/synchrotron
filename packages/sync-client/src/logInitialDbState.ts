import { SqlClient } from "@effect/sql"
import { ClientDbAdapter, ClientIdentity } from "@synchrotron/sync-core"
import { Effect } from "effect"

const toNumber = (value: unknown): number => {
	if (typeof value === "number") return Number.isFinite(value) ? value : 0
	if (typeof value === "bigint") return Number(value)
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

const boolFromPresent = (value: unknown): boolean => value === true || value === 1 || value === "1"

/**
 * Debug-only "initial DB state" log for client sync tables.
 *
 * This is intended to help debug high-level startup / lifecycle flows:
 * - Whether the sync schema exists
 * - Whether there are pending unsynced actions
 * - Whether there are synced-but-unapplied remote actions
 */
export const logInitialSyncDbState = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const clientDbAdapter = yield* ClientDbAdapter
	const identity = yield* ClientIdentity
	const clientId = yield* identity.get

	const requiredTables = [
		"action_records",
		"action_modified_rows",
		"client_sync_status",
		"local_applied_action_ids"
	] as const

	const tableExists = (tableName: string) => {
		if (clientDbAdapter.dialect === "sqlite") {
			return sql<{ readonly present: unknown }>`
				SELECT EXISTS (
					SELECT 1 FROM sqlite_master
					WHERE type = 'table'
					AND name = ${tableName}
				) AS present
			`.pipe(Effect.map((rows) => boolFromPresent(rows[0]?.present)))
		}

		return sql<{ readonly present: boolean }>`
			SELECT EXISTS (
				SELECT 1
				FROM information_schema.tables
				WHERE table_schema = current_schema()
				AND table_name = ${tableName}
			) AS present
		`.pipe(Effect.map((rows) => rows[0]?.present === true))
	}

	const tablePresence = yield* Effect.all(
		requiredTables.map((tableName) =>
			tableExists(tableName).pipe(Effect.map((present) => [tableName, present] as const))
		),
		{ concurrency: 1 }
	)

	const missingTables = tablePresence
		.filter(([, present]) => !present)
		.map(([tableName]) => tableName)
	if (missingTables.length > 0) {
		yield* Effect.logDebug("synchrotron.db.initialState.skipped", {
			clientId,
			dbDialect: clientDbAdapter.dialect,
			reason: "missing_tables",
			missingTables
		})
		return
	}

	const emptyActionCounts: {
		readonly action_records_total: number | string | null
		readonly action_records_synced: number | string | null
		readonly action_records_unsynced: number | string | null
		readonly action_records_with_server_ingest_id: number | string | null
		readonly action_records_without_server_ingest_id: number | string | null
		readonly action_records_local: number | string | null
		readonly action_records_remote: number | string | null
		readonly action_records_local_unsynced: number | string | null
		readonly action_records_remote_synced: number | string | null
	} = {
		action_records_total: 0,
		action_records_synced: 0,
		action_records_unsynced: 0,
		action_records_with_server_ingest_id: 0,
		action_records_without_server_ingest_id: 0,
		action_records_local: 0,
		action_records_remote: 0,
		action_records_local_unsynced: 0,
		action_records_remote_synced: 0
	}

	const actionCounts = yield* sql<{
		readonly action_records_total: number | string | null
		readonly action_records_synced: number | string | null
		readonly action_records_unsynced: number | string | null
		readonly action_records_with_server_ingest_id: number | string | null
		readonly action_records_without_server_ingest_id: number | string | null
		readonly action_records_local: number | string | null
		readonly action_records_remote: number | string | null
		readonly action_records_local_unsynced: number | string | null
		readonly action_records_remote_synced: number | string | null
	}>`
		SELECT
			COUNT(*) AS action_records_total,
			COALESCE(SUM(CASE WHEN synced = 1 THEN 1 ELSE 0 END), 0) AS action_records_synced,
			COALESCE(SUM(CASE WHEN synced = 0 THEN 1 ELSE 0 END), 0) AS action_records_unsynced,
			COALESCE(SUM(CASE WHEN server_ingest_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS action_records_with_server_ingest_id,
			COALESCE(SUM(CASE WHEN server_ingest_id IS NULL THEN 1 ELSE 0 END), 0) AS action_records_without_server_ingest_id,
			COALESCE(SUM(CASE WHEN client_id = ${clientId} THEN 1 ELSE 0 END), 0) AS action_records_local,
			COALESCE(SUM(CASE WHEN client_id != ${clientId} THEN 1 ELSE 0 END), 0) AS action_records_remote,
				COALESCE(SUM(CASE WHEN synced = 0 AND client_id = ${clientId} THEN 1 ELSE 0 END), 0) AS action_records_local_unsynced,
				COALESCE(SUM(CASE WHEN synced = 1 AND client_id != ${clientId} THEN 1 ELSE 0 END), 0) AS action_records_remote_synced
			FROM action_records
		`.pipe(Effect.map((rows) => rows[0] ?? emptyActionCounts))

	const emptyAmrCounts: {
		readonly amr_total: number | string | null
		readonly amr_for_synced_actions: number | string | null
		readonly amr_for_unsynced_actions: number | string | null
	} = {
		amr_total: 0,
		amr_for_synced_actions: 0,
		amr_for_unsynced_actions: 0
	}

	const amrCounts = yield* sql<{
		readonly amr_total: number | string | null
		readonly amr_for_synced_actions: number | string | null
		readonly amr_for_unsynced_actions: number | string | null
	}>`
		SELECT
			COUNT(*) AS amr_total,
				COALESCE(SUM(CASE WHEN ar.synced = 1 THEN 1 ELSE 0 END), 0) AS amr_for_synced_actions,
				COALESCE(SUM(CASE WHEN ar.synced = 0 THEN 1 ELSE 0 END), 0) AS amr_for_unsynced_actions
			FROM action_modified_rows amr
			JOIN action_records ar ON ar.id = amr.action_record_id
		`.pipe(Effect.map((rows) => rows[0] ?? emptyAmrCounts))

	const appliedCount = yield* sql<{ readonly n: number | string | null }>`
			SELECT COUNT(*) AS n FROM local_applied_action_ids
		`.pipe(Effect.map((rows) => toNumber(rows[0]?.n ?? 0)))

	const syncedButUnapplied = yield* sql<{ readonly n: number | string | null }>`
		SELECT COUNT(*) AS n
		FROM action_records ar
		LEFT JOIN local_applied_action_ids la ON la.action_record_id = ar.id
		WHERE ar.synced = 1
		AND la.action_record_id IS NULL
	`.pipe(Effect.map((rows) => toNumber(rows[0]?.n ?? 0)))

	const remoteSyncedButUnapplied = yield* sql<{ readonly n: number | string | null }>`
		SELECT COUNT(*) AS n
		FROM action_records ar
		LEFT JOIN local_applied_action_ids la ON la.action_record_id = ar.id
		WHERE ar.synced = 1
		AND ar.client_id != ${clientId}
		AND la.action_record_id IS NULL
	`.pipe(Effect.map((rows) => toNumber(rows[0]?.n ?? 0)))

	const clientSyncStatusRows = yield* sql<{ readonly n: number | string | null }>`
		SELECT COUNT(*) AS n FROM client_sync_status
	`.pipe(Effect.map((rows) => toNumber(rows[0]?.n ?? 0)))

	const lastSeenServerIngestId = yield* sql<{
		readonly last_seen_server_ingest_id: number | string | null
	}>`
		SELECT last_seen_server_ingest_id
		FROM client_sync_status
		WHERE client_id = ${clientId}
	`.pipe(Effect.map((rows) => toNumber(rows[0]?.last_seen_server_ingest_id ?? 0)))

	yield* Effect.logDebug("synchrotron.db.initialState", {
		clientId,
		dbDialect: clientDbAdapter.dialect,

		actionRecordsTotal: toNumber(actionCounts.action_records_total),
		actionRecordsSynced: toNumber(actionCounts.action_records_synced),
		actionRecordsUnsynced: toNumber(actionCounts.action_records_unsynced),
		actionRecordsWithServerIngestId: toNumber(actionCounts.action_records_with_server_ingest_id),
		actionRecordsWithoutServerIngestId: toNumber(
			actionCounts.action_records_without_server_ingest_id
		),
		actionRecordsLocal: toNumber(actionCounts.action_records_local),
		actionRecordsRemote: toNumber(actionCounts.action_records_remote),
		actionRecordsLocalUnsynced: toNumber(actionCounts.action_records_local_unsynced),
		actionRecordsRemoteSynced: toNumber(actionCounts.action_records_remote_synced),

		amrTotal: toNumber(amrCounts.amr_total),
		amrForSyncedActions: toNumber(amrCounts.amr_for_synced_actions),
		amrForUnsyncedActions: toNumber(amrCounts.amr_for_unsynced_actions),

		localAppliedActionIds: appliedCount,
		syncedButUnappliedActions: syncedButUnapplied,
		remoteSyncedButUnappliedActions: remoteSyncedButUnapplied,

		clientSyncStatusRows,
		lastSeenServerIngestId
	})
}).pipe(
	Effect.catchAll((error) =>
		Effect.logDebug("synchrotron.db.initialState.failed", {
			error: String(error)
		})
	),
	Effect.withSpan("SynchrotronClient.logInitialSyncDbState")
)
