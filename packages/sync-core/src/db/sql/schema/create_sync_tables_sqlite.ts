export default `-- Sync tables for SQLite client databases.
--
-- Notes:
-- - JSON values are stored as TEXT (JSON strings).
-- - \`clock_time_ms\` / \`clock_counter\` are STORED generated columns so we can index ordering.
-- - Use \`PRAGMA foreign_keys = ON\` for FK enforcement (per-connection in SQLite).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS action_records (
	id TEXT PRIMARY KEY,
	-- Server-side monotonic ingestion cursor (used only for incremental fetch/streaming).
	-- Nullable so clients can store local-only actions without a server cursor.
	server_ingest_id INTEGER,
	_tag TEXT NOT NULL,
	client_id TEXT NOT NULL,
	transaction_id REAL NOT NULL,
	clock TEXT NOT NULL,
	clock_time_ms INTEGER GENERATED ALWAYS AS (
		COALESCE(CAST(json_extract(clock, '$.timestamp') AS INTEGER), 0)
	) STORED,
	clock_counter INTEGER GENERATED ALWAYS AS (
		COALESCE(CAST(json_extract(clock, '$.vector."' || client_id || '"') AS INTEGER), 0)
	) STORED,
	args TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	synced INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS action_records_clock_order_idx
ON action_records(clock_time_ms, clock_counter, client_id, id);

CREATE INDEX IF NOT EXISTS action_records_server_ingest_id_idx
ON action_records(server_ingest_id);

CREATE UNIQUE INDEX IF NOT EXISTS action_records_server_ingest_id_unique_idx
ON action_records(server_ingest_id)
WHERE server_ingest_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS action_records_synced_idx ON action_records(synced);
CREATE INDEX IF NOT EXISTS action_records_client_id_idx ON action_records(client_id);
CREATE INDEX IF NOT EXISTS action_records_transaction_id_idx ON action_records(transaction_id);

CREATE TABLE IF NOT EXISTS action_modified_rows (
	id TEXT PRIMARY KEY,
	table_name TEXT NOT NULL,
	row_id TEXT NOT NULL,
	action_record_id TEXT NOT NULL,
	operation TEXT NOT NULL,
	forward_patches TEXT NOT NULL DEFAULT '{}',
	reverse_patches TEXT NOT NULL DEFAULT '{}',
	sequence INTEGER NOT NULL,
	FOREIGN KEY (action_record_id) REFERENCES action_records(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS action_modified_rows_action_idx ON action_modified_rows(action_record_id);
CREATE UNIQUE INDEX IF NOT EXISTS action_modified_rows_unique_idx
ON action_modified_rows(table_name, row_id, action_record_id, sequence);

CREATE TABLE IF NOT EXISTS client_sync_status (
	client_id TEXT PRIMARY KEY,
	current_clock TEXT NOT NULL,
	last_synced_clock TEXT NOT NULL,
	last_seen_server_ingest_id INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS local_applied_action_ids (
	action_record_id TEXT PRIMARY KEY
);
`
