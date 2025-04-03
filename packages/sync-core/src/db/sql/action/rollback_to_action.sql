CREATE OR REPLACE FUNCTION rollback_to_action(p_action_id TEXT) -- p_action_id can be NULL
RETURNS VOID AS $$
DECLARE
    target_action_record RECORD;
    target_sortable_clock TEXT := NULL; -- Initialize target clock to NULL
    -- is_target_applied BOOLEAN; -- No longer needed within this function
    action_ids_to_unapply TEXT[];
    amr_ids_to_reverse TEXT[];
BEGIN
    -- Disable triggers to prevent recursion or unwanted side effects during rollback
    PERFORM set_config('sync.disable_trigger', 'true', true);

    -- 1. Handle the target action ID (if provided)
    IF p_action_id IS NOT NULL THEN
        SELECT * INTO target_action_record FROM action_records WHERE id = p_action_id;

        IF target_action_record IS NULL THEN
            PERFORM set_config('sync.disable_trigger', 'false', true);
            RAISE EXCEPTION 'Action record not found with id: %', p_action_id;
        END IF;

        -- Check removed: The check for local_applied_action_ids is done before calling this function now.

        target_sortable_clock := target_action_record.sortable_clock;
    ELSE
         RAISE NOTICE 'p_action_id is NULL, rolling back all locally applied actions.';
    END IF;

    -- 2. Find AMRs to reverse and Action IDs to unapply in a single query
    -- Revision: Select ALL actions newer than the target, regardless of local applied status,
    -- to ensure full state rollback. Determine which subset *was* locally applied for cleanup.
    WITH actions_to_rollback AS (
        SELECT ar.id as action_id, ar.sortable_clock
        FROM action_records ar
        WHERE (target_sortable_clock IS NULL OR ar.sortable_clock > target_sortable_clock)
    )
    SELECT
        array_agg(amr.id ORDER BY atr.sortable_clock DESC, amr.sequence DESC),
        -- Aggregate only the action IDs that were actually in local_applied_action_ids before the rollback
        (SELECT array_agg(action_id) FROM actions_to_rollback WHERE action_id IN (SELECT action_record_id FROM local_applied_action_ids))
    INTO
        amr_ids_to_reverse,
        action_ids_to_unapply
    FROM action_modified_rows amr
    JOIN actions_to_rollback atr ON amr.action_record_id = atr.action_id;


    -- 3. Apply reverse patches using the existing batch function
    IF amr_ids_to_reverse IS NOT NULL AND array_length(amr_ids_to_reverse, 1) > 0 THEN
        RAISE NOTICE 'Rolling back AMRs: %', amr_ids_to_reverse;
        PERFORM apply_reverse_amr_batch(amr_ids_to_reverse);
    END IF;

    -- 4. Remove the rolled-back actions from the local applied set
    IF action_ids_to_unapply IS NOT NULL AND array_length(action_ids_to_unapply, 1) > 0 THEN
        DELETE FROM local_applied_action_ids
        WHERE action_record_id = ANY(action_ids_to_unapply);
        RAISE NOTICE 'Successfully rolled back and removed actions from local applied set: %', action_ids_to_unapply;
    ELSE
        RAISE NOTICE 'No actions needed to be rolled back or removed from local applied set.';
    END IF;


    -- Re-enable triggers
    PERFORM set_config('sync.disable_trigger', 'false', true);

EXCEPTION WHEN OTHERS THEN
    -- Ensure triggers are re-enabled in case of error
    -- Use 'false' (text) not boolean true. Also, the third arg 'is_local' should likely be false here.
    PERFORM set_config('sync.disable_trigger', 'false', false); 
    RAISE; -- Re-raise the original error
END;
$$ LANGUAGE plpgsql;