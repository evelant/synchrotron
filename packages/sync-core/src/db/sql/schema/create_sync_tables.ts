export default `-- Create action_records table
CREATE TABLE IF NOT EXISTS action_records (
	id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
	-- Server-side monotonic ingestion cursor (used only for incremental fetch/streaming).
	-- This is intentionally nullable so clients can store local-only actions without a server cursor.
	server_ingest_id BIGINT,
	_tag TEXT NOT NULL,
	-- Application principal identity (used for server-side RLS scoping).
	-- Nullable so existing/local-only client actions can be stored without auth context.
	user_id TEXT,
	client_id TEXT NOT NULL,
	transaction_id FLOAT NOT NULL,
	clock JSONB NOT NULL,
	-- Canonical, index-friendly ordering fields derived from \`clock\` + \`client_id\`.
	-- See \`DESIGN.md\`.
	clock_time_ms BIGINT NOT NULL,
	clock_counter BIGINT NOT NULL,
	args JSONB NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
	synced INTEGER NOT NULL DEFAULT 0
);

CREATE SEQUENCE IF NOT EXISTS action_records_server_ingest_id_seq;

CREATE OR REPLACE FUNCTION compute_action_record_clock_order_columns()
RETURNS TRIGGER AS $$
BEGIN
	IF NEW.clock IS NOT NULL THEN
		NEW.clock_time_ms = COALESCE((NEW.clock->>'timestamp')::BIGINT, 0);
		NEW.clock_counter = COALESCE((NEW.clock->'vector'->>NEW.client_id)::BIGINT, 0);
	ELSE
		NEW.clock_time_ms = 0;
		NEW.clock_counter = 0;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS action_records_clock_order_columns_trigger ON action_records;
CREATE TRIGGER action_records_clock_order_columns_trigger
BEFORE INSERT OR UPDATE ON action_records
FOR EACH ROW EXECUTE FUNCTION compute_action_record_clock_order_columns();

CREATE INDEX IF NOT EXISTS action_records_clock_order_idx
ON action_records(clock_time_ms, clock_counter, client_id, id);

CREATE INDEX IF NOT EXISTS action_records_server_ingest_id_idx
ON action_records(server_ingest_id);

CREATE UNIQUE INDEX IF NOT EXISTS action_records_server_ingest_id_unique_idx
ON action_records(server_ingest_id)
WHERE server_ingest_id IS NOT NULL;


	-- Create indexes for action_records
	CREATE INDEX IF NOT EXISTS action_records_synced_idx ON action_records(synced);
	CREATE INDEX IF NOT EXISTS action_records_client_id_idx ON action_records(client_id);
	CREATE INDEX IF NOT EXISTS action_records_user_id_idx ON action_records(user_id);
	CREATE INDEX IF NOT EXISTS action_records_transaction_id_idx ON action_records(transaction_id);
	
	-- Create action_modified_rows table
	CREATE TABLE IF NOT EXISTS action_modified_rows (
		id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL,
		action_record_id TEXT NOT NULL,
		-- Application-defined visibility scope token (see docs/shared-rows.md).
		-- Required so RLS can efficiently filter sync log rows for shared/collaborative data.
		audience_key TEXT NOT NULL,
		operation TEXT NOT NULL,
	forward_patches JSONB DEFAULT '{}'::jsonb,
	reverse_patches JSONB DEFAULT '{}'::jsonb,
	sequence INT NOT NULL, -- Added sequence number
	FOREIGN KEY (action_record_id) REFERENCES action_records(id) ON DELETE CASCADE
);

-- Create indexes for action_modified_rows
CREATE INDEX IF NOT EXISTS action_modified_rows_action_idx ON action_modified_rows(action_record_id);
CREATE INDEX IF NOT EXISTS action_modified_rows_audience_key_idx ON action_modified_rows(audience_key);
CREATE INDEX IF NOT EXISTS action_modified_rows_action_audience_key_idx ON action_modified_rows(action_record_id, audience_key);
-- Removed old unique index as multiple rows per action/row are now allowed
-- Add new unique index including sequence
CREATE UNIQUE INDEX IF NOT EXISTS action_modified_rows_unique_idx ON action_modified_rows(table_name, row_id, action_record_id, sequence);

-- Create client_sync_status table for vector clocks
CREATE TABLE IF NOT EXISTS client_sync_status (
	client_id TEXT PRIMARY KEY,
	current_clock JSONB NOT NULL,
	last_synced_clock JSONB NOT NULL,
	-- Server ingestion watermark used for incremental remote fetch.
	last_seen_server_ingest_id BIGINT NOT NULL DEFAULT 0
);

-- Create client-local table to track applied actions
CREATE TABLE IF NOT EXISTS local_applied_action_ids (
	action_record_id TEXT PRIMARY KEY
);
`
