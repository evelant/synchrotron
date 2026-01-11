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

		const sendLocalActions = (
			actions: ReadonlyArray<ActionRecord>,
			amrs: ReadonlyArray<ActionModifiedRow>
		) =>
			Effect.gen(function* () {
				yield* Effect.logInfo(
					`Client: Sending ${actions.length} local actions to server and ${amrs.length} AMRs`,
					actions
				)
				return yield* client.SendLocalActions({ actions: actions, amrs: amrs, clientId })
			}).pipe(
				Effect.tapErrorCause((c) =>
					Effect.logError(
						`Client: Failed to send local actions: ${Cause.defects(c).pipe(
							Chunk.map((d) => JSON.stringify(d, undefined, 2)),
							Chunk.toArray,
							(a) => a.join(",")
						)}`
					)
				),
				Effect.mapError(
					(error) => new NetworkRequestError({ message: error.message, cause: error })
				)
			)
		const fetchRemoteActions = () =>
			Effect.gen(function* () {
				yield* Effect.logInfo(`Client: Fetching remote actions for client ${clientId}`)
				const sinceServerIngestId = yield* clockService.getLastSeenServerIngestId
				yield* Effect.logInfo(`Client: fetching remote actions since server_ingest_id`, {
					sinceServerIngestId
				})
				const actions = yield* client.FetchRemoteActions({ clientId, sinceServerIngestId })
				yield* Effect.logInfo(
					`fetched remote actions ${actions.actions.length} actions and ${actions.modifiedRows.length} AMRs`
				)
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
				return actions
			}).pipe(
				Effect.mapError(
					(error) => new RemoteActionFetchError({ message: error.message, cause: error })
				)
			)

		return SyncNetworkService.of({
			_tag: "SyncNetworkService",
			sendLocalActions,
			fetchRemoteActions
		})
	})
).pipe(Layer.provide(ProtocolLive)) // Provide the configured protocol layer
