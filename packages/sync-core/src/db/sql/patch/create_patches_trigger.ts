export default `CREATE OR REPLACE FUNCTION create_patches_trigger(p_table_name TEXT) RETURNS VOID AS $$
DECLARE
	id_exists BOOLEAN;
	audience_key_exists BOOLEAN;
	trigger_exists BOOLEAN;
BEGIN
	-- Check if the id column exists in the table
	SELECT EXISTS (
		SELECT 1 
		FROM information_schema.columns
		WHERE table_name = p_table_name
		AND column_name = 'id'
	) INTO id_exists;

	-- Check if the audience_key column exists in the table (required for shared-row RLS model).
	SELECT EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_name = p_table_name
		AND column_name = 'audience_key'
	) INTO audience_key_exists;

	-- Error if required columns are missing
	IF NOT id_exists THEN
		RAISE EXCEPTION 'Table % is missing required "id" column. All tables managed by the sync system must have an id column.', p_table_name;
	END IF;

	IF NOT audience_key_exists THEN
		RAISE EXCEPTION 'Table % is missing required "audience_key" column. All tables managed by the sync system must have an audience_key column (see docs/shared-rows.md).', p_table_name;
	END IF;

	-- Check if the trigger already exists
	SELECT EXISTS (
		SELECT 1
		FROM pg_trigger
		WHERE tgname = 'generate_patches_trigger'
		AND tgrelid = (p_table_name::regclass)::oid
	) INTO trigger_exists;

	
	-- If trigger doesn't exist, add it
	IF NOT trigger_exists THEN
		EXECUTE format('
			CREATE TRIGGER generate_patches_trigger
			AFTER INSERT OR UPDATE OR DELETE ON %I
			FOR EACH ROW
			EXECUTE FUNCTION generate_patches();
		', p_table_name);
		RAISE NOTICE 'Created generate_patches_trigger on table %', p_table_name;
	ELSE
		RAISE NOTICE 'generate_patches_trigger already exists on table %', p_table_name;
	END IF;
END;
$$ LANGUAGE plpgsql;
`
