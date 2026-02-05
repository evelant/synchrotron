import type { SqlClient } from "@effect/sql"
import { Effect, Metric } from "effect"
import * as SyncMetrics from "../observability/metrics"
import type { SyncNetworkService } from "../SyncNetworkService"
import type { BootstrapSnapshot } from "./SyncServiceBootstrap"

/**
 * Bootstrap the local client database from a server snapshot when the client is truly empty.
 *
 * Conditions:
 * - client has never seen a server ingest id (`last_seen_server_ingest_id = 0`)
 * - local `action_records` is empty (no local-only actions to preserve)
 *
 * This is best-effort: failures are logged and the sync loop continues.
 */
export const bootstrapFromSnapshotIfNeeded = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly syncNetworkService: SyncNetworkService
	readonly clientId: string
	readonly syncSessionId: string
	readonly lastSeenServerIngestIdBeforeBootstrap: number
	readonly applyBootstrapSnapshot: (
		snapshot: BootstrapSnapshot
	) => Effect.Effect<void, unknown, never>
}) =>
	Effect.gen(function* () {
		const {
			sqlClient,
			syncNetworkService,
			clientId,
			syncSessionId,
			lastSeenServerIngestIdBeforeBootstrap
		} = deps

		if (lastSeenServerIngestIdBeforeBootstrap > 0) return false

		const [localState] = yield* sqlClient<{
			readonly has_any_action_records: boolean | 0 | 1
		}>`
			SELECT EXISTS (SELECT 1 FROM action_records LIMIT 1) as has_any_action_records
		`
		const hasAnyActionRecords =
			typeof localState?.has_any_action_records === "boolean"
				? localState.has_any_action_records
				: localState?.has_any_action_records === 1
		if (hasAnyActionRecords) return false

		yield* Effect.logInfo("performSync.bootstrap.start", { clientId, syncSessionId })
		const snapshot = yield* syncNetworkService.fetchBootstrapSnapshot().pipe(
			Metric.trackDuration(
				SyncMetrics.rpcDurationMsFor({ method: "FetchBootstrapSnapshot", side: "client" })
			),
			Effect.tap(() =>
				Metric.increment(
					SyncMetrics.rpcRequestsTotalFor({
						method: "FetchBootstrapSnapshot",
						side: "client",
						outcome: "success"
					})
				)
			),
			Effect.tapError(() =>
				Metric.increment(
					SyncMetrics.rpcRequestsTotalFor({
						method: "FetchBootstrapSnapshot",
						side: "client",
						outcome: "error"
					})
				)
			),
			Effect.tapError((error) =>
				Metric.increment(
					SyncMetrics.rpcFailuresTotalFor({
						method: "FetchBootstrapSnapshot",
						side: "client",
						reason: SyncMetrics.rpcFailureReasonFromError(error)
					})
				)
			),
			Effect.withSpan("SyncNetworkService.fetchBootstrapSnapshot", {
				kind: "client",
				attributes: {
					clientId,
					syncSessionId,
					"rpc.system": "synchrotron",
					"rpc.service": "SyncNetworkRpc",
					"rpc.method": "FetchBootstrapSnapshot"
				}
			})
		)
		yield* Effect.logInfo("performSync.bootstrap.received", {
			clientId,
			serverIngestId: snapshot.serverIngestId,
			tableCount: snapshot.tables.length,
			rowCounts: snapshot.tables.map((t) => ({
				tableName: t.tableName,
				rowCount: t.rows.length
			}))
		})

		yield* deps.applyBootstrapSnapshot(snapshot)
		yield* Metric.increment(SyncMetrics.bootstrapEmptyTotal)

		yield* Effect.logInfo("performSync.bootstrap.done", {
			clientId,
			serverIngestId: snapshot.serverIngestId
		})

		return true
	}).pipe(
		Effect.catchAll((error) =>
			Effect.logWarning("performSync.bootstrap.failed", {
				clientId: deps.clientId,
				message: error instanceof Error ? error.message : String(error)
			}).pipe(Effect.as(false))
		)
	)
