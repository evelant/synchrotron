/**
 * Quarantine gate for uploads.
 *
 * If `local_quarantined_actions` is non-empty, uploads are skipped to avoid repeatedly sending
 * actions the server has rejected (until the user/app discards or resolves them).
 */
import type { SqlClient } from "@effect/sql"
import { Effect } from "effect"

export const makeUploadQuarantineGate = (deps: { readonly sqlClient: SqlClient.SqlClient }) => {
	const { sqlClient } = deps

	const getQuarantinedCount = () =>
		sqlClient<{ readonly count: number | string }>`
			SELECT count(*) as count FROM local_quarantined_actions
		`.pipe(
			Effect.map((rows) => {
				const raw = rows[0]?.count ?? 0
				const parsed = typeof raw === "number" ? raw : Number(raw ?? 0)
				return Number.isFinite(parsed) ? parsed : 0
			})
		)

	return { getQuarantinedCount } as const
}
