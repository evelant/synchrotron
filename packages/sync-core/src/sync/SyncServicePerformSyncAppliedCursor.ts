import type { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { ClientClockState } from "../ClientClockState"

/**
 * Applied-cursor helper: compute the maximum `server_ingest_id` among remote (other-client)
 * actions that are already incorporated into the local materialized state.
 *
 * We treat `last_seen_server_ingest_id` as an "applied" watermark (not merely ingested):
 * - safe to use as `basisServerIngestId` for upload gating (under the honest-client assumption)
 * - does not advance past ingested-but-unapplied remote actions (e.g. concurrent Electric ingest)
 */
export const makeAppliedRemoteCursor = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly clockState: ClientClockState
	readonly clientId: string
}) => {
	const { sqlClient, clockState, clientId } = deps

	/**
	 * Computes the maximum `server_ingest_id` for remote (other-client) actions that are already
	 * incorporated into local materialized state (i.e. present in `local_applied_action_ids`).
	 */
	const getMaxAppliedRemoteServerIngestId = () =>
		sqlClient<{ readonly max_server_ingest_id: number | string | null }>`
			SELECT COALESCE(MAX(ar.server_ingest_id), 0) AS max_server_ingest_id
			FROM action_records ar
			JOIN local_applied_action_ids la ON la.action_record_id = ar.id
			WHERE ar.synced = 1
			AND ar.server_ingest_id IS NOT NULL
			AND ar.client_id != ${clientId}
		`.pipe(
			Effect.map((rows) => {
				const raw = rows[0]?.max_server_ingest_id ?? 0
				const parsed = typeof raw === "number" ? raw : Number(raw)
				return Number.isFinite(parsed) ? parsed : 0
			})
		)

	/**
	 * Advances the client cursor (`last_seen_server_ingest_id`) to the applied-remote watermark.
	 * This is safe for upload gating because it never moves past ingested-but-unapplied actions.
	 */
	const advanceAppliedRemoteServerIngestCursor = () =>
		getMaxAppliedRemoteServerIngestId().pipe(
			Effect.flatMap((maxApplied) => clockState.advanceLastSeenServerIngestId(maxApplied))
		)

	return { getMaxAppliedRemoteServerIngestId, advanceAppliedRemoteServerIngestCursor } as const
}
