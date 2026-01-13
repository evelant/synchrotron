export default `CREATE OR REPLACE FUNCTION generate_patches() RETURNS TRIGGER AS $$
DECLARE
	patches_data RECORD;
	v_action_record_id TEXT;
	amr_record RECORD;
	v_sequence_number INT; -- Added sequence number variable
	target_row_id TEXT;
	old_row_data JSONB;
	new_row_data JSONB;
	operation_type TEXT;
	v_table_name TEXT;
	result JSONB;
	disable_tracking BOOLEAN;
BEGIN
	-- Check if the trigger is disabled for this session
	-- Check session-level setting (removed 'true' from current_setting)
	-- Revert to checking transaction-local setting only
	IF COALESCE(current_setting('sync.disable_trigger', true), 'false') = 'true' THEN
		RAISE NOTICE '[generate_patches] Trigger disabled by sync.disable_trigger setting.';
		RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; -- Return appropriate value without doing anything
	END IF;

	RAISE NOTICE '[generate_patches] Trigger fired for OP: %, Table: %', 
		TG_OP, 
		TG_TABLE_NAME;


	-- Check if tracking is disabled for testing
	SELECT current_setting('test_disable_tracking', true) = 'true' INTO disable_tracking;
	IF disable_tracking THEN
		RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; -- Return appropriate value without doing anything
	END IF;

	-- Determine operation type and prepare data based on trigger operation
	IF TG_OP = 'DELETE' THEN
		old_row_data := to_jsonb(OLD);
		new_row_data := '{}'::JSONB;
		operation_type := 'DELETE';
		target_row_id := OLD.id;
		RAISE NOTICE '[generate_patches] DELETE detected for RowID: %', target_row_id;
	ELSIF TG_OP = 'INSERT' THEN
		old_row_data := '{}'::JSONB;
		new_row_data := to_jsonb(NEW);
		operation_type := 'INSERT';
		target_row_id := NEW.id;
		RAISE NOTICE '[generate_patches] INSERT detected for RowID: %', target_row_id;
	ELSIF TG_OP = 'UPDATE' THEN
		-- Regular update (soft delete logic removed)
		old_row_data := to_jsonb(OLD);
		new_row_data := to_jsonb(NEW);
		operation_type := 'UPDATE';
		target_row_id := NEW.id;
		RAISE NOTICE '[generate_patches] UPDATE detected for RowID: %', target_row_id;
	END IF;

	-- Get the current transaction ID
	v_action_record_id := NULLIF(current_setting('sync.capture_action_record_id', true), '');

	-- If no action record exists for this transaction, we have a problem
	IF v_action_record_id IS NULL THEN
		RAISE WARNING '[generate_patches] sync.capture_action_record_id not set for OP: %, Table: %', TG_OP, TG_TABLE_NAME;
		RAISE EXCEPTION 'sync.capture_action_record_id not set';
	END IF;

	-- Calculate the next sequence number for this action record
	SELECT COALESCE(MAX(sequence), -1) + 1 INTO v_sequence_number
	FROM action_modified_rows
	WHERE action_record_id = v_action_record_id;

	-- Store TG_TABLE_NAME in variable to avoid ambiguity
	v_table_name := TG_TABLE_NAME;

	-- Handle based on operation type
	IF TG_OP = 'DELETE' THEN
		-- Handle soft deletion by calling the handler function with the existing amr record
		result := handle_remove_operation(
			v_action_record_id, 
			v_table_name, 
			target_row_id, 
			operation_type, 
			old_row_data,
			v_sequence_number -- Pass sequence number
		);
		RETURN OLD;
	ELSIF TG_OP = 'INSERT' THEN
		-- For new rows, delegate to the insert handler
		-- We always call the handler, it will check for existing entries internally
		result := handle_insert_operation(
			v_action_record_id,
			v_table_name,
			target_row_id,
			operation_type,
			old_row_data,
			new_row_data,
			v_sequence_number -- Pass sequence number
		);
	ELSIF TG_OP = 'UPDATE' THEN
		-- For modifications to existing rows, delegate to the update handler
		result := handle_update_operation(
			v_action_record_id,
			v_table_name,
			target_row_id,
			old_row_data,
			new_row_data,
			operation_type,
			v_sequence_number -- Pass sequence number
		);
	END IF;

	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	ELSE
		RETURN NEW;
	END IF;
END;
$$ LANGUAGE plpgsql; 
`
