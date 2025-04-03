CREATE OR REPLACE FUNCTION generate_op_patches(
	old_data JSONB, 
	new_data JSONB, 
	op_type TEXT
) RETURNS TABLE(forward_patches JSONB, reverse_patches JSONB) AS $$
DECLARE
	diff_key TEXT;
	old_val JSONB;
	new_val JSONB;
BEGIN
	-- Initialize default empty patches
	forward_patches := '{}'::JSONB;
	reverse_patches := '{}'::JSONB;

	IF op_type = 'INSERT' THEN
		-- For INSERT, forward patch has all column values
		forward_patches := new_data;
		-- For INSERT, reverse patches is empty (removal is implied by operation type)
		reverse_patches := '{}'::JSONB;
	ELSIF op_type = 'DELETE' THEN
		-- For DELETE, forward patch is empty (removal is implied by operation type)
		forward_patches := '{}'::JSONB;
		-- For DELETE, reverse patch has all column values to restore the entire row
		reverse_patches := old_data;
	ELSIF op_type = 'UPDATE' THEN
		-- For UPDATE, generate patches only for changed fields
		-- Compare old and new values and build patches
		FOR diff_key, new_val IN SELECT * FROM jsonb_each(new_data)
		LOOP
			old_val := old_data->diff_key;

			-- Skip if no change
			IF new_val IS DISTINCT FROM old_val THEN
				-- Forward patch has new value
				forward_patches := jsonb_set(forward_patches, ARRAY[diff_key], new_val);
				-- Reverse patch has old value
				reverse_patches := jsonb_set(reverse_patches, ARRAY[diff_key], old_val);
			END IF;
		END LOOP;

		-- Check for removed fields
		FOR diff_key, old_val IN SELECT * FROM jsonb_each(old_data)
		LOOP
			IF new_data->diff_key IS NULL THEN
				-- For removed fields, use null in forward (explicit null)
				forward_patches := jsonb_set(forward_patches, ARRAY[diff_key], 'null'::jsonb);
				-- Reverse patch has old value
				reverse_patches := jsonb_set(reverse_patches, ARRAY[diff_key], old_val);
			END IF;
		END LOOP;
	END IF;

	RETURN NEXT;
END;
$$ LANGUAGE plpgsql; 