export default `CREATE OR REPLACE FUNCTION handle_insert_operation(
	p_action_record_id TEXT,
	p_table_name TEXT,
	p_row_id TEXT,
	p_operation_type TEXT,
	p_old_data JSONB,
	p_new_data JSONB,
	p_sequence_number INT -- Added sequence number parameter
) RETURNS JSONB AS $$
DECLARE
	patches_data RECORD;
	amr_id TEXT;
	result JSONB;
	new_amr_uuid TEXT; -- Variable for new UUID
	v_audience_key TEXT;
BEGIN
	-- Generate patches
	SELECT * INTO patches_data FROM generate_op_patches(
		p_old_data, 
		p_new_data, 
		p_operation_type
	);

	-- Capture audience scope token (stored separately on the AMR row; omitted from patches).
	v_audience_key := COALESCE(p_new_data->>'audience_key', p_old_data->>'audience_key');
	IF v_audience_key IS NULL OR v_audience_key = '' THEN
		RAISE EXCEPTION 'Cannot capture patches: missing audience_key for table %, row %', p_table_name, p_row_id;
	END IF;

	patches_data.forward_patches := patches_data.forward_patches - 'audience_key';
	patches_data.reverse_patches := patches_data.reverse_patches - 'audience_key';

	-- Explicitly generate UUID
	new_amr_uuid := gen_random_uuid();
	RAISE NOTICE '[handle_insert_operation] Generated new AMR UUID: % for ActionID: %, Sequence: %', new_amr_uuid, p_action_record_id, p_sequence_number; -- Add logging

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
		p_operation_type,
		patches_data.forward_patches,
		patches_data.reverse_patches,
		p_sequence_number -- Use sequence number parameter
	); 
	-- No RETURNING needed as we already have the ID

	amr_id := new_amr_uuid; -- Assign generated UUID to return variable
	
	-- Return the result
	result := jsonb_build_object(
		'success', TRUE,
		'message', 'INSERT operation tracked successfully',
		'amr_id', amr_id
	);
	
	RETURN result;
END;
$$ LANGUAGE plpgsql;`
