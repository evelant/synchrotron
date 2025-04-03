CREATE OR REPLACE FUNCTION compare_hlc(hlc1 JSONB, hlc2 JSONB) RETURNS INT AS $$
DECLARE
	ts1 BIGINT;
	ts2 BIGINT;
	vector_comparison INT;
BEGIN
	-- Extract timestamps
	ts1 := (hlc1->>'timestamp')::BIGINT;
	ts2 := (hlc2->>'timestamp')::BIGINT;
	
	-- Compare timestamps first
	IF ts1 > ts2 THEN
		RETURN 1;  -- hlc1 > hlc2
	ELSIF ts1 < ts2 THEN
		RETURN -1; -- hlc1 < hlc2
	ELSE
		-- If timestamps are equal, compare vectors
		vector_comparison := compare_vector_clocks(hlc1->'vector', hlc2->'vector');
		
		-- Return the vector comparison result
		-- 1: hlc1 > hlc2
		-- -1: hlc1 < hlc2
		-- 0: hlc1 = hlc2
		-- 2: concurrent
		RETURN vector_comparison;
	END IF;
END;
$$ LANGUAGE plpgsql; 