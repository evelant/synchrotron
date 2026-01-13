export default `CREATE OR REPLACE FUNCTION apply_reverse_amr(p_amr_id TEXT) RETURNS VOID AS $$
DECLARE
	amr_record RECORD;
	column_name TEXT;
	column_value JSONB;
	sql_command TEXT;
	columns_list TEXT DEFAULT '';
	values_list TEXT DEFAULT '';
	target_table TEXT;
	target_id TEXT;
BEGIN
	-- Get the action_modified_rows entry
	SELECT * INTO amr_record FROM action_modified_rows WHERE id = p_amr_id;

	IF amr_record IS NULL THEN
		RAISE EXCEPTION 'action_modified_rows record not found with id: %', p_amr_id;
	END IF;

	target_table := amr_record.table_name;
	target_id := amr_record.row_id;

	-- Handle operation type (note: we're considering the inverted operation)
	IF amr_record.operation = 'INSERT' THEN
		-- Reverse of INSERT is DELETE - delete the row entirely
		RAISE NOTICE '[apply_reverse_amr] Reversing INSERT for table %, id %', target_table, target_id;
		EXECUTE format('DELETE FROM %I WHERE id = %L', target_table, target_id);

	ELSIF amr_record.operation = 'DELETE' THEN
		-- Reverse of DELETE is INSERT - restore the row with its original values from reverse_patches
		RAISE NOTICE '[apply_reverse_amr] Reversing DELETE for table %, id %', target_table, target_id;
		columns_list := ''; values_list := '';
		-- Ensure 'id' is included if not present in patches
		IF NOT (amr_record.reverse_patches ? 'id') THEN
			columns_list := 'id'; values_list := quote_literal(target_id);
		END IF;

		FOR column_name, column_value IN SELECT * FROM jsonb_each(amr_record.reverse_patches)
		LOOP
			IF columns_list <> '' THEN columns_list := columns_list || ', '; values_list := values_list || ', '; END IF;
			columns_list := columns_list || quote_ident(column_name);
			IF column_value IS NULL OR column_value = 'null'::jsonb THEN
				values_list := values_list || 'NULL';
			ELSIF jsonb_typeof(column_value) = 'array' AND column_name = 'tags' THEN
				values_list := values_list || format(CASE WHEN jsonb_array_length(column_value) = 0 THEN '''{}''::text[]' ELSE quote_literal(ARRAY(SELECT jsonb_array_elements_text(column_value))) || '::text[]' END);
			ELSIF jsonb_typeof(column_value) = 'object' THEN
				-- For JSONB objects, preserve the structure
				values_list := values_list || format('%L::jsonb', column_value);
			ELSE
				values_list := values_list || quote_nullable(column_value#>>'{}');
			END IF;
		END LOOP;

		IF columns_list <> '' THEN
			-- Attempt INSERT, let PK violation handle cases where row might already exist
			sql_command := format('INSERT INTO %I (%s) VALUES (%s) ON CONFLICT (id) DO NOTHING', target_table, columns_list, values_list);
			EXECUTE sql_command;
		ELSE
			RAISE EXCEPTION 'CRITICAL ERROR: Cannot apply reverse of DELETE - reverse patches are empty. Table: %, ID: %', target_table, target_id;
		END IF;

	ELSIF amr_record.operation = 'UPDATE' THEN
		-- For reverse of UPDATE, apply the reverse patches to revert changes
		RAISE NOTICE '[apply_reverse_amr] Reversing UPDATE for table %, id %', target_table, target_id;
		sql_command := format('UPDATE %I SET ', target_table);
		columns_list := '';

		FOR column_name, column_value IN SELECT * FROM jsonb_each(amr_record.reverse_patches)
		LOOP
			IF column_name <> 'id' THEN
				IF columns_list <> '' THEN columns_list := columns_list || ', '; END IF;
				IF column_value IS NULL OR column_value = 'null'::jsonb THEN
					columns_list := columns_list || format('%I = NULL', column_name);
				ELSIF jsonb_typeof(column_value) = 'array' AND column_name = 'tags' THEN
					columns_list := columns_list || format('%I = %L::text[]', column_name, CASE WHEN jsonb_array_length(column_value) = 0 THEN '{}' ELSE ARRAY(SELECT jsonb_array_elements_text(column_value)) END);
				ELSIF jsonb_typeof(column_value) = 'object' THEN
					-- For JSONB objects, preserve the structure
					columns_list := columns_list || format('%I = %L::jsonb', column_name, column_value);
				ELSE
					columns_list := columns_list || format('%I = %L', column_name, column_value#>>'{}');
				END IF;
			END IF;
		END LOOP;

		IF columns_list <> '' THEN
			sql_command := sql_command || columns_list || format(' WHERE id = %L', target_id);
			EXECUTE sql_command; -- If row doesn't exist, this affects 0 rows.
		ELSE
			RAISE NOTICE 'No columns to revert for %', p_amr_id;
		END IF;
	END IF;

EXCEPTION WHEN OTHERS THEN
	RAISE; -- Re-raise the original error
END;
$$ LANGUAGE plpgsql;`
