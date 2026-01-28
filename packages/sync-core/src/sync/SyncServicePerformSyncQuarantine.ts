import type { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Query helpers for the local quarantine table used by the sync runtime.
 *
 * We keep this logic centralized because different SQL clients return `count(*)`
 * with different types (number vs string).
 */
export const getQuarantinedActionCount = (sqlClient: SqlClient.SqlClient) =>
	sqlClient<{ readonly count: number | string }>`
		SELECT count(*) as count FROM local_quarantined_actions
	`.pipe(
		Effect.map((rows) => {
			const raw = rows[0]?.count ?? 0
			return typeof raw === "number" ? raw : Number(raw ?? 0)
		})
	)
