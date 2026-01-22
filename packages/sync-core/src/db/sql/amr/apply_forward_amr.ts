export default `CREATE OR REPLACE FUNCTION apply_forward_amr(p_amr_id TEXT) RETURNS VOID AS $$
	DECLARE
		amr_record RECORD;
		action_record_tag TEXT;
		action_record_user_id TEXT;
		column_name TEXT;
		column_value JSONB;
		sql_command TEXT;
		columns_list TEXT DEFAULT '';
		values_list TEXT DEFAULT '';
		target_exists BOOLEAN;
		target_table TEXT;
		target_id TEXT;
		forward_patches_obj JSONB;
		target_has_audience_key BOOLEAN DEFAULT false;
		target_audience_key_generated BOOLEAN DEFAULT false;
	BEGIN
	-- Get the action_modified_rows entry
	SELECT * INTO amr_record FROM action_modified_rows WHERE id = p_amr_id;

	IF amr_record IS NULL THEN
		RAISE EXCEPTION 'action_modified_rows record not found with id: %', p_amr_id;
	END IF;

	-- Get the tag from the associated action_record
	SELECT _tag, user_id
	INTO action_record_tag, action_record_user_id
	FROM action_records
	WHERE id = amr_record.action_record_id;

		-- Apply patches under the originating action principal (server-side RLS).
		IF action_record_user_id IS NOT NULL THEN
			PERFORM set_config('synchrotron.user_id', action_record_user_id, true);
			PERFORM set_config('request.jwt.claim.sub', action_record_user_id, true);
		END IF;

		target_table := amr_record.table_name;
		target_id := amr_record.row_id;

		-- Detect audience_key column on the target table (and whether it is generated).
		-- Some apps store audience_key only in action_modified_rows (for filtering) and omit it from
		-- forward_patches to avoid duplication. If the base table has a non-generated audience_key
		-- column, we must still include it for INSERTs to satisfy RLS / NOT NULL constraints.
		SELECT
			true,
			(attgenerated IS NOT NULL AND attgenerated <> '')
		INTO
			target_has_audience_key,
			target_audience_key_generated
		FROM pg_attribute
		WHERE attrelid = to_regclass(target_table)
		AND attname = 'audience_key'
		AND NOT attisdropped
		LIMIT 1;

		-- Normalize forward_patches for INSERT/UPDATE. We expect a JSON object, but defensive
		-- parsing helps if something double-encoded JSON into a JSONB string.
		forward_patches_obj := amr_record.forward_patches;
		IF forward_patches_obj IS NULL OR forward_patches_obj = 'null'::jsonb THEN
		forward_patches_obj := '{}'::jsonb;
	END IF;
	IF jsonb_typeof(forward_patches_obj) = 'string' THEN
		forward_patches_obj := (forward_patches_obj #>> '{}')::jsonb;
	END IF;

	-- Handle operation type
	IF amr_record.operation = 'DELETE' THEN
		-- Check if record exists before attempting delete
		EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE id = %L)', target_table, target_id) INTO target_exists;

		IF target_exists THEN
			-- Perform hard delete
			EXECUTE format('DELETE FROM %I WHERE id = %L', target_table, target_id);
		ELSE
			-- If the row doesn't exist AND it's a RollbackAction, it's expected, so don't error.
			IF action_record_tag = 'RollbackAction' THEN
				RAISE NOTICE 'Skipping DELETE forward patch for RollbackAction on non-existent row. Table: %, ID: %',
					target_table, target_id;
			ELSE
				-- For other actions, this might still indicate an issue, but we'll log instead of raising for now
				RAISE NOTICE 'Attempted DELETE forward patch on non-existent row (Action: %). Table: %, ID: %',
					action_record_tag, target_table, target_id;
				-- RAISE EXCEPTION 'CRITICAL ERROR: Cannot apply DELETE operation - row does not exist. Table: %, ID: %',
				--	 target_table, target_id;
			END IF;
		END IF;

		ELSIF amr_record.operation = 'INSERT' THEN
			IF jsonb_typeof(forward_patches_obj) IS DISTINCT FROM 'object' THEN
				RAISE EXCEPTION 'apply_forward_amr: forward_patches must be a JSON object (amr %, type %, value %)',
					p_amr_id, jsonb_typeof(forward_patches_obj), forward_patches_obj;
			END IF;

			-- Attempt direct INSERT. Let PK violation handle existing rows.
				columns_list := ''; values_list := '';
				IF NOT (forward_patches_obj ? 'id') THEN
					columns_list := 'id'; values_list := quote_literal(target_id);
				END IF;

				-- If the target table has a non-generated audience_key column and the patches omit it,
				-- supply it from action_modified_rows.audience_key.
				IF amr_record.audience_key IS NOT NULL
					AND NOT (forward_patches_obj ? 'audience_key')
					AND target_has_audience_key
					AND NOT target_audience_key_generated THEN
					IF columns_list <> '' THEN columns_list := columns_list || ', '; values_list := values_list || ', '; END IF;
					columns_list := columns_list || quote_ident('audience_key');
					values_list := values_list || quote_nullable(amr_record.audience_key);
				END IF;

			FOR column_name, column_value IN SELECT * FROM jsonb_each(forward_patches_obj)
			LOOP
				-- Never attempt to write generated audience_key columns.
				IF column_name = 'audience_key'
					AND target_has_audience_key
					AND target_audience_key_generated THEN
					CONTINUE;
				END IF;
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
				-- Idempotency: if the row already exists, do nothing.
				-- This prevents duplicate-ingest or retry paths from failing on PK violations.
				sql_command := format(
					'INSERT INTO %I (%s) VALUES (%s) ON CONFLICT (id) DO NOTHING',
					target_table,
					columns_list,
					values_list
				);
				EXECUTE sql_command;
			ELSE
				RAISE EXCEPTION 'CRITICAL ERROR: Cannot apply INSERT operation - forward patches are empty. Table: %, ID: %', target_table, target_id;
			END IF;

	ELSIF amr_record.operation = 'UPDATE' THEN
		IF jsonb_typeof(forward_patches_obj) IS DISTINCT FROM 'object' THEN
			RAISE EXCEPTION 'apply_forward_amr: forward_patches must be a JSON object (amr %, type %, value %)',
				p_amr_id, jsonb_typeof(forward_patches_obj), forward_patches_obj;
		END IF;

		-- Attempt direct UPDATE. If row doesn't exist, it affects 0 rows.
		sql_command := format('UPDATE %I SET ', target_table);
		columns_list := '';

			FOR column_name, column_value IN SELECT * FROM jsonb_each(forward_patches_obj)
			LOOP
				IF column_name <> 'id' THEN
					-- Never attempt to write generated audience_key columns.
					IF column_name = 'audience_key'
						AND target_has_audience_key
						AND target_audience_key_generated THEN
						CONTINUE;
					END IF;
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
			EXECUTE sql_command;
		ELSE
			RAISE NOTICE 'No columns to update for %', p_amr_id;
		END IF;
	END IF;

EXCEPTION WHEN OTHERS THEN
	RAISE; -- Re-raise the original error
END;
$$ LANGUAGE plpgsql;`
