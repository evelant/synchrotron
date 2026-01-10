-- find_common_ancestor Function
-- Finds the most recent common ancestor action between the set of local actions
-- present in the 'action_records' table.
-- It considers local pending actions (synced=false) and actions not yet applied locally
-- (not present in local_applied_action_ids) to determine the point of divergence.
-- This is typically the latest action known by both peers *before* any divergence occurred.

-- Parameters: None

-- Returns:
--   SETOF action_records: Returns 0 or 1 row from the 'action_records' table representing the common ancestor.

CREATE OR REPLACE FUNCTION find_common_ancestor()
RETURNS SETOF action_records
LANGUAGE plpgsql
STABLE -- Function does not modify the database and returns same results for same inputs within a transaction
AS $$
DECLARE
    v_non_ancestor_count BIGINT;
BEGIN
    -- CTE for actions synced from remote but not yet applied locally
    WITH remote_actions_unapplied AS (
        SELECT ar.id, ar.clock_time_ms, ar.clock_counter, ar.client_id
        FROM action_records ar
        LEFT JOIN local_applied_action_ids la ON ar.id = la.action_record_id
        WHERE ar.synced = TRUE AND la.action_record_id IS NULL -- Synced but not locally applied
    ),
    -- CTE combining local pending actions (synced = FALSE) and unapplied remote actions.
    -- These represent actions that occurred *after* the potential common ancestor.
    non_ancestor_actions AS (
        SELECT id, clock_time_ms, clock_counter, client_id from action_records WHERE synced = FALSE -- Local pending
        UNION ALL
        SELECT id, clock_time_ms, clock_counter, client_id FROM remote_actions_unapplied -- Synced but not locally applied
    )
    -- Check if there are any non-ancestor actions.
    SELECT count(*) INTO v_non_ancestor_count FROM non_ancestor_actions;

    -- If there are no pending local actions and no unapplied remote actions, the histories haven't diverged.
    IF v_non_ancestor_count = 0 THEN
        -- The common ancestor is simply the latest action that is marked as synced AND locally applied.
        RETURN QUERY
        SELECT a.*
        FROM action_records a
        JOIN local_applied_action_ids la ON a.id = la.action_record_id -- Must be locally applied
        WHERE a.synced = TRUE -- Must be synced
        ORDER BY a.clock_time_ms DESC, a.clock_counter DESC, a.client_id DESC, a.id DESC
        LIMIT 1;
    ELSE
        -- If there are non-ancestor actions, find the one with the earliest HLC clock.
        -- This represents the first point of divergence or new information.
        -- The common ancestor is the latest *synced* and *locally applied* action whose HLC clock
        -- is strictly *before* the earliest non-ancestor action's clock.
        RETURN QUERY
        WITH remote_actions_unapplied AS ( -- Re-declare CTEs for this branch
            SELECT ar.id, ar.clock_time_ms, ar.clock_counter, ar.client_id
            FROM action_records ar
            LEFT JOIN local_applied_action_ids la ON ar.id = la.action_record_id
            WHERE ar.synced = TRUE AND la.action_record_id IS NULL
        ), non_ancestor_actions AS (
            SELECT id, clock_time_ms, clock_counter, client_id from action_records WHERE synced = FALSE
            UNION ALL
            SELECT id, clock_time_ms, clock_counter, client_id FROM remote_actions_unapplied
        ),
        -- Find the single earliest non-ancestor action based on HLC clock order.
        earliest_non_ancestor AS (
             SELECT naa.clock_time_ms, naa.clock_counter, naa.client_id, naa.id
             FROM non_ancestor_actions naa
             ORDER BY naa.clock_time_ms ASC, naa.clock_counter ASC, naa.client_id ASC, naa.id ASC
             LIMIT 1
        )
        SELECT a.*
        FROM action_records a
        JOIN local_applied_action_ids la ON a.id = la.action_record_id -- Must be locally applied
        CROSS JOIN earliest_non_ancestor ena -- Cross join is acceptable as ena has at most 1 row
        WHERE
            a.synced = TRUE -- Ancestor must be synced
            -- Canonical replay-order comparison. Find actions strictly earlier than the first non-ancestor.
            AND (a.clock_time_ms, a.clock_counter, a.client_id, a.id) < (ena.clock_time_ms, ena.clock_counter, ena.client_id, ena.id)
        -- Order by canonical replay order descending to get the latest among potential ancestors.
        ORDER BY a.clock_time_ms DESC, a.clock_counter DESC, a.client_id DESC, a.id DESC
        LIMIT 1;
    END IF;

END;
$$;
