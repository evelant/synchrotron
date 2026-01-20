export default `CREATE OR REPLACE FUNCTION handle_remove_operation(
	p_action_record_id TEXT,
	p_table_name TEXT,
	p_row_id TEXT,
	p_operation_type TEXT, -- Should always be 'DELETE' when called from generate_patches trigger
	p_old_data JSONB,
	p_sequence_number INT -- Added sequence number, removed p_amr_record
) RETURNS JSONB AS $$
DECLARE
	forward_patch JSONB;
	reverse_patch JSONB;
	amr_id TEXT;
	result JSONB;
	new_amr_uuid TEXT; -- Variable for new UUID
	v_audience_key TEXT;
BEGIN
	RAISE NOTICE '[handle_remove_operation] Called for ActionID: %, Table: %, RowID: %, Sequence: %', 
		p_action_record_id, 
		p_table_name, 
		p_row_id,
		p_sequence_number;

	-- Always insert a new record for each delete operation
	forward_patch := '{}'::jsonb; -- Forward patch for DELETE is empty
	v_audience_key := COALESCE(p_old_data->>'audience_key', null);
	IF v_audience_key IS NULL OR v_audience_key = '' THEN
		RAISE EXCEPTION 'Cannot capture patches: missing audience_key for table %, row %', p_table_name, p_row_id;
	END IF;

	reverse_patch := p_old_data - 'audience_key'; -- Reverse patch contains the data before delete (excluding audience_key)

	-- Explicitly generate UUID
	new_amr_uuid := gen_random_uuid();

	INSERT INTO action_modified_rows (
		id, -- Explicitly provide the generated id
		action_record_id, 
		table_name, 
		row_id, 
		audience_key,
		operation, 
		forward_patches, 
		reverse_patches,
		sequence -- Add sequence column
	) VALUES (
		new_amr_uuid, -- Use generated UUID
		p_action_record_id, 
		p_table_name, 
		p_row_id, 
		v_audience_key,
		'DELETE', -- Operation is always DELETE here
		forward_patch, 
		reverse_patch,
		p_sequence_number -- Use sequence number parameter
	);

	amr_id := new_amr_uuid; -- Assign generated UUID to return variable

	RAISE NOTICE '[handle_remove_operation] Inserted new DELETE AMR with ID: %', amr_id;
	result := jsonb_build_object(
		'success', TRUE,
		'message', 'DELETE operation tracked successfully as new AMR',
		'amr_id', amr_id
	);

	RETURN result;
END;
$$ LANGUAGE plpgsql;`
