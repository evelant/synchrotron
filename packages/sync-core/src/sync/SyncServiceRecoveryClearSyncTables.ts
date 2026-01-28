/**
 * Clears the local sync log + bookkeeping tables.
 *
 * This is used by both `hardResync` and `rebase`. It runs with:
 * - capture context set to `null`
 * - patch tracking disabled (avoid generating synthetic AMRs during destructive resets)
 *
 * The caller owns the transaction boundary.
 */
import type { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { ClientDbAdapterService } from "../ClientDbAdapter"

export const clearSyncTablesInTx = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly clientDbAdapter: ClientDbAdapterService
}) => {
	const { sqlClient, clientDbAdapter } = deps

	return clientDbAdapter.withCaptureContext(
		null,
		clientDbAdapter.withPatchTrackingDisabled(
			Effect.gen(function* () {
				yield* sqlClient`DELETE FROM action_modified_rows`.pipe(Effect.asVoid)
				yield* sqlClient`DELETE FROM action_records`.pipe(Effect.asVoid)
				yield* sqlClient`DELETE FROM local_applied_action_ids`.pipe(Effect.asVoid)
				yield* sqlClient`DELETE FROM local_quarantined_actions`.pipe(Effect.asVoid)
			})
		)
	)
}
