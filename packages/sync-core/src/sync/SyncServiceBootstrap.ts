import type { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { ClientDbAdapterService } from "../ClientDbAdapter"
import type { ActionRecord } from "../models"

export type BootstrapSnapshot = {
	readonly serverEpoch: string
	readonly minRetainedServerIngestId: number
	readonly serverIngestId: number
	readonly serverClock: ActionRecord["clock"]
	readonly tables: ReadonlyArray<{
		readonly tableName: string
		readonly rows: ReadonlyArray<Record<string, unknown>>
	}>
}

export const makeBootstrapSnapshotApplier = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly clientDbAdapter: ClientDbAdapterService
	readonly clientId: string
}) => {
	const { sqlClient, clientDbAdapter, clientId } = deps

	const preserveSnapshotArrays = sqlClient.onDialectOrElse({
		pg: () => true,
		sqlite: () => false,
		orElse: () => false
	})

	const sanitizeSnapshotRow = (row: Record<string, unknown>) => {
		const out: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(row)) {
			if (key === "audience_key") continue
			if (value === undefined) continue
			if (value instanceof Date) {
				out[key] = value.toISOString()
				continue
			}
			if (Array.isArray(value)) {
				out[key] = preserveSnapshotArrays ? value : JSON.stringify(value)
				continue
			}
			if (typeof value === "object" && value !== null) {
				out[key] = JSON.stringify(value)
				continue
			}
			out[key] = value
		}
		return out
	}

	const applyBootstrapSnapshotInTx = (snapshot: BootstrapSnapshot) =>
		clientDbAdapter.withCaptureContext(
			null,
			clientDbAdapter.withPatchTrackingDisabled(
				Effect.gen(function* () {
					for (const table of snapshot.tables) {
						yield* sqlClient`DELETE FROM ${sqlClient(table.tableName)}`.pipe(Effect.asVoid)
						for (const row of table.rows) {
							const sanitized = sanitizeSnapshotRow(row)
							if (Object.keys(sanitized).length === 0) continue
							yield* sqlClient`
								INSERT INTO ${sqlClient(table.tableName)}
								${sqlClient.insert(sanitized)}
							`.pipe(Effect.asVoid)
						}
					}

					const serverClockJson = JSON.stringify(snapshot.serverClock)
					yield* sqlClient`
						INSERT INTO client_sync_status (
							client_id,
							current_clock,
							last_synced_clock,
							server_epoch,
							last_seen_server_ingest_id
						) VALUES (
							${clientId},
							${serverClockJson},
							${serverClockJson},
							${snapshot.serverEpoch},
							${snapshot.serverIngestId}
						)
						ON CONFLICT (client_id) DO UPDATE SET
							current_clock = excluded.current_clock,
							last_synced_clock = excluded.last_synced_clock,
							server_epoch = excluded.server_epoch,
							last_seen_server_ingest_id = excluded.last_seen_server_ingest_id
					`.pipe(Effect.asVoid)
				})
			)
		)

	const applyBootstrapSnapshot = (snapshot: BootstrapSnapshot) =>
		applyBootstrapSnapshotInTx(snapshot).pipe(sqlClient.withTransaction)

	return { applyBootstrapSnapshotInTx, applyBootstrapSnapshot } as const
}
