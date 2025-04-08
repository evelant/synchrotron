-- Create action_records table
CREATE TABLE IF NOT EXISTS action_records (
	id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
	_tag TEXT NOT NULL,
	client_id TEXT NOT NULL,
	transaction_id FLOAT NOT NULL,
	clock JSONB NOT NULL,
	args JSONB NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
	synced BOOLEAN DEFAULT FALSE,
	-- Sortable string representation of HLC
	-- Correctly orders by timestamp, then by version vector, then by client ID alphabetically
	sortable_clock TEXT
);

CREATE OR REPLACE FUNCTION compute_sortable_clock(clock JSONB)
RETURNS TEXT AS $$
DECLARE
	ts TEXT;
	max_counter INT := 0;
	max_counter_key TEXT := ''; -- Default key
	row_num INT := 0; -- Default row number
	sortable_clock TEXT;
	vector_is_empty BOOLEAN;
BEGIN
	ts := lpad((clock->>'timestamp'), 15, '0');

	-- Check if vector exists and is not empty
	-- Correct way to check if the jsonb object is empty or null
	vector_is_empty := (clock->'vector' IS NULL) OR (clock->'vector' = '{}'::jsonb);

	IF NOT vector_is_empty THEN
		-- Find the max counter and its alphabetical first key
		SELECT key, (value::INT) INTO max_counter_key, max_counter
		FROM jsonb_each_text(clock->'vector')
		ORDER BY value::INT DESC, key ASC
		LIMIT 1;

		-- Determine row number (alphabetical order) of max_counter_key
		-- Ensure max_counter_key is not null or empty before using it
		IF max_counter_key IS NOT NULL AND max_counter_key != '' THEN
			 SELECT rn INTO row_num FROM (
				SELECT key, ROW_NUMBER() OVER (ORDER BY key ASC) as rn
				FROM jsonb_each_text(clock->'vector')
			) AS sub
			WHERE key = max_counter_key;
		ELSE
			 -- Handle case where vector might exist but query didn't return expected key (shouldn't happen if not empty)
			 max_counter_key := ''; -- Reset to default if something went wrong
			 max_counter := 0;
			 row_num := 0;
		END IF;
	END IF; -- Defaults are used if vector_is_empty

	-- Build the sortable clock explicitly
	-- Use COALESCE to handle potential nulls just in case, though defaults should prevent this
	sortable_clock := ts || '-' ||
						  lpad(COALESCE(max_counter, 0)::TEXT, 10, '0') || '-' ||
						  lpad(COALESCE(row_num, 0)::TEXT, 5, '0') || '-' ||
						  COALESCE(max_counter_key, ''); -- Use empty string if key is null

	RETURN sortable_clock;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION compute_sortable_clock()
RETURNS TRIGGER AS $$
DECLARE
    ts TEXT;
    max_counter INT := 0;
    max_counter_key TEXT := '';
    row_num INT := 0;
BEGIN
	-- Ensure the input clock is not null before calling the computation function
	IF NEW.clock IS NOT NULL THEN
		NEW.sortable_clock = compute_sortable_clock(NEW.clock);
	ELSE
		-- Decide how to handle null input clock, maybe set sortable_clock to NULL or a default?
		NEW.sortable_clock = NULL; -- Or some default string like '000000000000000-0000000000-00000-'
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS action_records_sortable_clock_trigger ON action_records;
CREATE TRIGGER action_records_sortable_clock_trigger
BEFORE INSERT OR UPDATE ON action_records
FOR EACH ROW EXECUTE FUNCTION compute_sortable_clock();

CREATE INDEX IF NOT EXISTS action_records_sortable_clock_idx ON action_records(sortable_clock);


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
	last_synced_clock JSONB NOT NULL,
	sortable_current_clock TEXT,
	sortable_last_synced_clock TEXT

);

CREATE OR REPLACE FUNCTION compute_sortable_clocks_on_sync_status()
RETURNS TRIGGER AS $$
DECLARE
    ts TEXT;
    max_counter INT := 0;
    max_counter_key TEXT := '';
    row_num INT := 0;
BEGIN
	IF NEW.current_clock IS NOT NULL THEN
		NEW.sortable_current_clock = compute_sortable_clock(NEW.current_clock);
	ELSE
		NEW.sortable_current_clock = NULL;
	END IF;

	IF NEW.last_synced_clock IS NOT NULL THEN
		NEW.sortable_last_synced_clock = compute_sortable_clock(NEW.last_synced_clock);
	ELSE
		NEW.sortable_last_synced_clock = NULL;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS client_sync_status_sortable_clock_trigger ON client_sync_status;
CREATE TRIGGER client_sync_status_sortable_clock_trigger
BEFORE INSERT OR UPDATE ON client_sync_status
FOR EACH ROW EXECUTE FUNCTION compute_sortable_clocks_on_sync_status();

CREATE INDEX IF NOT EXISTS client_sync_status_sortable_clock_idx ON client_sync_status(sortable_current_clock);
CREATE INDEX IF NOT EXISTS client_sync_status_sortable_last_synced_clock_idx ON client_sync_status(sortable_last_synced_clock);

-- Create client-local table to track applied actions
CREATE TABLE IF NOT EXISTS local_applied_action_ids (
	action_record_id TEXT PRIMARY KEY
);