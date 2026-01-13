export default `CREATE OR REPLACE FUNCTION compare_vector_clocks(v1 JSONB, v2 JSONB) RETURNS INT AS $$
DECLARE
	v1_greater BOOLEAN := FALSE;
	v2_greater BOOLEAN := FALSE;
	client_id TEXT;
	v1_value INT;
	v2_value INT;
BEGIN
	-- First, check keys in v1
	FOR client_id, v1_value IN SELECT * FROM jsonb_each_text(v1)
	LOOP
		v2_value := (v2->>client_id)::INT;
		IF v2_value IS NULL THEN
			v2_value := 0;
		END IF;
		
		IF v1_value > v2_value THEN
			v1_greater := TRUE;
		ELSIF v1_value < v2_value THEN
			v2_greater := TRUE;
		END IF;
	END LOOP;
	
	-- Then check keys in v2 that may not be in v1
	FOR client_id, v2_value IN SELECT * FROM jsonb_each_text(v2)
	LOOP
		v1_value := (v1->>client_id)::INT;
		IF v1_value IS NULL THEN
			v1_value := 0;
		END IF;
		
		IF v1_value > v2_value THEN
			v1_greater := TRUE;
		ELSIF v1_value < v2_value THEN
			v2_greater := TRUE;
		END IF;
	END LOOP;
	
	-- Determine the result based on comparisons
	IF v1_greater AND NOT v2_greater THEN
		RETURN 1;  -- v1 > v2
	ELSIF v2_greater AND NOT v1_greater THEN
		RETURN -1; -- v1 < v2
	ELSIF v1_greater AND v2_greater THEN
		RETURN 2;  -- Concurrent (neither is strictly greater)
	ELSE
		RETURN 0;  -- Equal
	END IF;
END;
$$ LANGUAGE plpgsql; `
