import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { SqlClient } from "@effect/sql"
import { ClockService } from "@synchrotron/sync-core/ClockService"
import { SynchrotronClientConfig } from "@synchrotron/sync-core/config"
import { SyncNetworkRpcGroup } from "@synchrotron/sync-core/SyncNetworkRpc"
import {
	NetworkRequestError,
	RemoteActionFetchError,
	SyncNetworkService
} from "@synchrotron/sync-core/SyncNetworkService"
import { ActionRecord, type ActionModifiedRow } from "@synchrotron/sync-core/models"
import { Cause, Chunk, Effect, Layer } from "effect"

const valuePreview = (value: unknown, maxLength = 500) => {
	const json = JSON.stringify(value)
	return json.length <= maxLength ? json : `${json.slice(0, maxLength)}…`
}

// Choose which protocol to use
const ProtocolLive = Layer.unwrapEffect(
	Effect.gen(function* () {
		const config = yield* SynchrotronClientConfig
		return RpcClient.layerProtocolHttp({ url: config.syncRpcUrl }).pipe(
			Layer.provide([
				// use fetch for http requests
				FetchHttpClient.layer,
				// use ndjson for serialization
				RpcSerialization.layerJson
			])
		)
	})
)

export const SyncNetworkServiceLive = Layer.scoped(
	SyncNetworkService,
	Effect.gen(function* (_) {
		const clockService = yield* ClockService
		const clientId = yield* clockService.getNodeId
		// Get the RPC client instance using the schema
		const client = yield* RpcClient.make(SyncNetworkRpcGroup)
		const sql = yield* SqlClient.SqlClient

		const json = (value: unknown) => JSON.stringify(value)

		const summarizeActions = (actions: ReadonlyArray<ActionRecord>) =>
			actions.map((a) => ({
				id: a.id,
				_tag: a._tag,
				client_id: a.client_id,
				server_ingest_id: a.server_ingest_id,
				transaction_id: a.transaction_id,
				clock: a.clock
			}))

		const summarizeAmrs = (amrs: ReadonlyArray<ActionModifiedRow>) => {
			const countsByActionRecordId: Record<string, number> = {}
			const countsByTable: Record<string, number> = {}
			for (const amr of amrs) {
				countsByActionRecordId[amr.action_record_id] =
					(countsByActionRecordId[amr.action_record_id] ?? 0) + 1
				countsByTable[amr.table_name] = (countsByTable[amr.table_name] ?? 0) + 1
			}
			return { countsByActionRecordId, countsByTable }
		}

			const sendLocalActions = (
				actions: ReadonlyArray<ActionRecord>,
				amrs: ReadonlyArray<ActionModifiedRow>,
				basisServerIngestId: number
			) =>
				Effect.gen(function* () {
					const amrSummary = summarizeAmrs(amrs)
					yield* Effect.logInfo("sync.network.sendLocalActions.start", {
						clientId,
						basisServerIngestId,
						actionCount: actions.length,
						amrCount: amrs.length,
						actionTags: actions.reduce<Record<string, number>>((acc, a) => {
							acc[a._tag] = (acc[a._tag] ?? 0) + 1
							return acc
					}, {}),
					amrCountsByTable: amrSummary.countsByTable
				})

				const syncActionIds = new Set(
					actions.filter((a) => a._tag === "_InternalSyncApply").map((a) => a.id)
				)
				if (syncActionIds.size > 0) {
					const syncAmrs = amrs.filter((amr) => syncActionIds.has(amr.action_record_id)).slice(0, 10)
					yield* Effect.logDebug("sync.network.sendLocalActions.syncDelta.preview", {
						clientId,
						syncActionIds: Array.from(syncActionIds),
						syncAmrPreview: syncAmrs.map((amr) => ({
							id: amr.id,
							table_name: amr.table_name,
							row_id: amr.row_id,
							operation: amr.operation,
							forward_patches: valuePreview(amr.forward_patches),
							reverse_patches: valuePreview(amr.reverse_patches)
						}))
					})
				}

				yield* Effect.logDebug("sync.network.sendLocalActions.payload", {
					clientId,
					actions: summarizeActions(actions),
					amrs: {
						countsByActionRecordId: amrSummary.countsByActionRecordId,
						countsByTable: amrSummary.countsByTable
						}
					})

					const result = yield* client.SendLocalActions({
						actions,
						amrs,
						clientId,
						basisServerIngestId
					})
					yield* Effect.logInfo("sync.network.sendLocalActions.success", {
						clientId,
						basisServerIngestId,
						actionCount: actions.length,
						amrCount: amrs.length
					})
					return result
			}).pipe(
				Effect.tapErrorCause((c) =>
					Effect.logError(
						"sync.network.sendLocalActions.error",
						{
							clientId,
							cause: Cause.pretty(c),
							defects: Cause.defects(c).pipe(
								Chunk.map((d) => JSON.stringify(d, undefined, 2)),
								Chunk.toArray
							)
						}
					)
				),
				Effect.mapError(
					(error) =>
						new NetworkRequestError({
							message: error instanceof Error ? error.message : String(error),
							cause: error
						})
				)
			)
		const fetchRemoteActions = () =>
			Effect.gen(function* () {
				yield* Effect.logInfo("sync.network.fetchRemoteActions.start", { clientId })
				const sinceServerIngestId = yield* clockService.getLastSeenServerIngestId
				yield* Effect.logInfo("sync.network.fetchRemoteActions.cursor", {
					clientId,
					sinceServerIngestId
				})
				const actions = yield* client.FetchRemoteActions({ clientId, sinceServerIngestId })
				yield* Effect.logInfo("sync.network.fetchRemoteActions.result", {
					clientId,
					actionCount: actions.actions.length,
					amrCount: actions.modifiedRows.length,
					actionTags: actions.actions.reduce<Record<string, number>>((acc, a) => {
						acc[a._tag] = (acc[a._tag] ?? 0) + 1
						return acc
					}, {})
				})
				yield* Effect.all(
					actions.actions.map(
						(a) =>
							sql`
								INSERT INTO action_records ${sql.insert({
									server_ingest_id: a.server_ingest_id,
									id: a.id,
									_tag: a._tag,
									client_id: a.client_id,
									transaction_id: a.transaction_id,
									clock: json(a.clock),
									args: json(a.args),
									created_at: new Date(a.created_at).toISOString(),
									synced: 1
								})}
								ON CONFLICT (id) DO NOTHING
							`
					)
				)
				yield* Effect.all(
					actions.modifiedRows.map(
						(a) =>
							sql`
								INSERT INTO action_modified_rows ${sql.insert({
									id: a.id,
									table_name: a.table_name,
									row_id: a.row_id,
									action_record_id: a.action_record_id,
									operation: a.operation,
									forward_patches: json(a.forward_patches),
									reverse_patches: json(a.reverse_patches),
									sequence: a.sequence
								})}
								ON CONFLICT (id) DO NOTHING
							`
					)
				)
				yield* Effect.logDebug("sync.network.fetchRemoteActions.persisted", {
					clientId,
					actionCount: actions.actions.length,
					amrCount: actions.modifiedRows.length,
					actions: summarizeActions(actions.actions),
					amrs: summarizeAmrs(actions.modifiedRows)
				})
				return actions
			}).pipe(
				Effect.mapError(
					(error) =>
						new RemoteActionFetchError({
							message: error instanceof Error ? error.message : String(error),
							cause: error
						})
				)
			)

		return SyncNetworkService.of({
			_tag: "SyncNetworkService",
			sendLocalActions,
			fetchRemoteActions
		})
	})
).pipe(Layer.provide(ProtocolLive)) // Provide the configured protocol layer
