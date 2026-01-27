import type { SqlClient } from "@effect/sql"
import { Effect, Option } from "effect"
import type { ServerMetaService } from "../ServerMetaService"
import { SyncSnapshotConfig } from "../SyncSnapshotConfig"
import { ServerInternalError } from "../SyncServerServiceErrors"
import type { BootstrapSnapshotResult } from "../SyncServerServiceTypes"
import { SyncUserId } from "../SyncUserId"

export const makeSnapshot = (deps: {
	readonly sql: SqlClient.SqlClient
	readonly serverMeta: ServerMetaService
	readonly minRetainedServerIngestId: () => Effect.Effect<number, unknown, never>
}) => {
	const { sql, serverMeta, minRetainedServerIngestId } = deps

	const toNumber = (value: unknown): number => {
		if (typeof value === "number") return value
		if (typeof value === "bigint") return Number(value)
		if (typeof value === "string") return Number(value)
		return Number(value)
	}

	const getBootstrapSnapshot = (clientId: string) =>
		Effect.gen(function* () {
			const userId = yield* SyncUserId
			yield* sql`SELECT set_config('synchrotron.user_id', ${userId}, true)`
			yield* sql`SELECT set_config('request.jwt.claim.sub', ${userId}, true)`

			const serverEpoch = yield* serverMeta.ensureServerEpoch()
			const minRetained = yield* minRetainedServerIngestId()

			const snapshotConfigOption = yield* Effect.serviceOption(SyncSnapshotConfig)
			const snapshotConfig = Option.getOrElse(snapshotConfigOption, () => ({
				tables: [] as const
			}))
			if (snapshotConfig.tables.length === 0) {
				return yield* Effect.fail(
					new ServerInternalError({
						message: "Bootstrap snapshot is not configured (SyncSnapshotConfig.tables is empty)"
					})
				)
			}

			const headRow = yield* sql<{
				readonly max_server_ingest_id: number | string | bigint | null
			}>`
				SELECT COALESCE(MAX(server_ingest_id), 0) AS max_server_ingest_id
				FROM action_records
			`
			const serverIngestId = toNumber(headRow[0]?.max_server_ingest_id ?? 0)
			const serverClock = yield* serverMeta.getServerClock()

			const tables = yield* Effect.forEach(
				snapshotConfig.tables,
				(tableName) =>
					Effect.gen(function* () {
						const rows = yield* sql<Record<string, unknown>>`
							SELECT *
							FROM ${sql(tableName)}
							ORDER BY id ASC
						`
						return { tableName, rows } as const
					}),
				{ concurrency: 1 }
			)

			yield* Effect.logInfo("server.getBootstrapSnapshot.done", {
				userId,
				clientId,
				serverIngestId,
				tableCount: tables.length,
				rowCounts: tables.map((t) => ({ tableName: t.tableName, rowCount: t.rows.length }))
			})

			return {
				serverEpoch,
				minRetainedServerIngestId: minRetained,
				serverIngestId,
				serverClock,
				tables
			} satisfies BootstrapSnapshotResult
		}).pipe(
			sql.withTransaction,
			Effect.annotateLogs({
				serverOperation: "getBootstrapSnapshot",
				requestingClientId: clientId
			}),
			Effect.withSpan("SyncServerService.getBootstrapSnapshot", {
				attributes: { clientId }
			}),
			Effect.catchAll((error) => {
				const unknownError = error as unknown
				if (unknownError instanceof ServerInternalError) {
					return Effect.fail(unknownError)
				}
				const message = unknownError instanceof Error ? unknownError.message : String(unknownError)
				return Effect.fail(
					new ServerInternalError({
						message: `Unexpected error during getBootstrapSnapshot: ${message}`,
						cause: unknownError
					})
				)
			})
		)

	return { getBootstrapSnapshot } as const
}
