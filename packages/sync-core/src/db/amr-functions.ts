import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

import applyForwardAmrSQL from "./sql/amr/apply_forward_amr"
import applyReverseAmrSQL from "./sql/amr/apply_reverse_amr"

/**
 * Effect that creates action modified rows related functions
 */
export const createAmrFunctions = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient

	// Create apply_forward_amr function
	yield* sql.unsafe(applyForwardAmrSQL).raw

	// Create apply_reverse_amr function
	yield* sql.unsafe(applyReverseAmrSQL).raw

	// Create batch function to apply forward patches
	yield* sql`
	-- Batch function to apply forward patches for multiple AMR entries
	CREATE OR REPLACE FUNCTION apply_forward_amr_batch(p_amr_ids TEXT[]) RETURNS VOID AS $$
	DECLARE
		amr_id TEXT;
	BEGIN
		IF p_amr_ids IS NULL OR array_length(p_amr_ids, 1) IS NULL THEN
			RAISE NOTICE 'No action_modified_rows IDs provided to apply_forward_amr_batch';
			RETURN;
		END IF;
		
		-- Apply forward patches for each AMR in the array
		FOREACH amr_id IN ARRAY p_amr_ids
		LOOP
				PERFORM apply_forward_amr(amr_id);
		
		END LOOP;
	END;
	$$ LANGUAGE plpgsql;
	`

	// Create batch function to apply reverse patches
	yield* sql`
	-- Batch function to apply reverse patches for multiple AMR entries
	CREATE OR REPLACE FUNCTION apply_reverse_amr_batch(p_amr_ids TEXT[]) RETURNS VOID AS $$
	DECLARE
		amr_id TEXT;
	BEGIN
		IF p_amr_ids IS NULL OR array_length(p_amr_ids, 1) IS NULL THEN
			RAISE NOTICE 'No action_modified_rows IDs provided to apply_reverse_amr_batch';
			RETURN;
		END IF;
		
		-- Apply reverse patches for each AMR in the array IN REVERSE ORDER
		-- This is critical to maintain consistency - we must undo changes
		-- in the opposite order they were applied
		-- The input array p_amr_ids is already sorted DESC by rollback_to_action, so iterate normally.
		FOREACH amr_id IN ARRAY p_amr_ids LOOP
			-- amr_id is already assigned the current element by FOREACH
				PERFORM apply_reverse_amr(amr_id);
			
		END LOOP;
	END;
	$$ LANGUAGE plpgsql;
	`

	// Log completion for debugging
	yield* Effect.logInfo("AMR functions created successfully")
})
