-- Create action_records table
CREATE TABLE IF NOT EXISTS action_records (
	id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
	_tag TEXT NOT NULL,
	client_id TEXT NOT NULL,
	transaction_id FLOAT NOT NULL,
	clock JSONB NOT NULL,
	-- Canonical, index-friendly ordering fields derived from `clock` + `client_id`.
	-- See `docs/planning/todo/0001-rework-sort-key.md`.
	clock_time_ms BIGINT NOT NULL,
	clock_counter BIGINT NOT NULL,
	args JSONB NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
	synced BOOLEAN DEFAULT FALSE
);

-- Backwards-compatible migration for existing databases.
ALTER TABLE action_records ADD COLUMN IF NOT EXISTS clock_time_ms BIGINT;
ALTER TABLE action_records ADD COLUMN IF NOT EXISTS clock_counter BIGINT;

UPDATE action_records
SET
	clock_time_ms = COALESCE((clock->>'timestamp')::BIGINT, 0),
	clock_counter = COALESCE((clock->'vector'->>client_id)::BIGINT, 0)
WHERE clock_time_ms IS NULL OR clock_counter IS NULL;

ALTER TABLE action_records ALTER COLUMN clock_time_ms SET NOT NULL;
ALTER TABLE action_records ALTER COLUMN clock_counter SET NOT NULL;

-- Legacy cleanup: sortable_clock is fully removed (no longer used anywhere).
DROP TRIGGER IF EXISTS action_records_sortable_clock_trigger ON action_records;
DROP INDEX IF EXISTS action_records_sortable_clock_idx;
ALTER TABLE action_records DROP COLUMN IF EXISTS sortable_clock;

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


-- Create indexes for action_records
CREATE INDEX IF NOT EXISTS action_records_synced_idx ON action_records(synced);
CREATE INDEX IF NOT EXISTS action_records_client_id_idx ON action_records(client_id);
CREATE INDEX IF NOT EXISTS action_records_transaction_id_idx ON action_records(transaction_id);

-- Create action_modified_rows table
CREATE TABLE IF NOT EXISTS action_modified_rows (
	id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
	table_name TEXT NOT NULL,
	row_id TEXT NOT NULL,
	action_record_id TEXT NOT NULL,
	operation TEXT NOT NULL,
	forward_patches JSONB DEFAULT '{}'::jsonb,
	reverse_patches JSONB DEFAULT '{}'::jsonb,
	sequence INT NOT NULL, -- Added sequence number
	FOREIGN KEY (action_record_id) REFERENCES action_records(id) ON DELETE CASCADE
);

-- Create indexes for action_modified_rows
CREATE INDEX IF NOT EXISTS action_modified_rows_action_idx ON action_modified_rows(action_record_id);
-- Removed old unique index as multiple rows per action/row are now allowed
-- Add new unique index including sequence
CREATE UNIQUE INDEX IF NOT EXISTS action_modified_rows_unique_idx ON action_modified_rows(table_name, row_id, action_record_id, sequence);

-- Create client_sync_status table for vector clocks
CREATE TABLE IF NOT EXISTS client_sync_status (
	client_id TEXT PRIMARY KEY,
	current_clock JSONB NOT NULL,
	last_synced_clock JSONB NOT NULL
);

-- Legacy cleanup: sortable clock columns are fully removed (no longer used anywhere).
DROP TRIGGER IF EXISTS client_sync_status_sortable_clock_trigger ON client_sync_status;
DROP INDEX IF EXISTS client_sync_status_sortable_clock_idx;
DROP INDEX IF EXISTS client_sync_status_sortable_last_synced_clock_idx;
ALTER TABLE client_sync_status DROP COLUMN IF EXISTS sortable_current_clock;
ALTER TABLE client_sync_status DROP COLUMN IF EXISTS sortable_last_synced_clock;

-- Create client-local table to track applied actions
CREATE TABLE IF NOT EXISTS local_applied_action_ids (
	action_record_id TEXT PRIMARY KEY
);

-- Drop legacy sortable clock functions (fully removed).
DROP FUNCTION IF EXISTS compute_sortable_clocks_on_sync_status();
DROP FUNCTION IF EXISTS compute_sortable_clock();
DROP FUNCTION IF EXISTS compute_sortable_clock(JSONB);
