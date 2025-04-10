import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { PgLiteClient } from "@effect/sql-pglite"
import { ClockService } from "@synchrotron/sync-core/ClockService"
import { SyncNetworkRpcGroup } from "@synchrotron/sync-core/SyncNetworkRpc"
import {
	NetworkRequestError,
	RemoteActionFetchError,
	SyncNetworkService
} from "@synchrotron/sync-core/SyncNetworkService"
import { ActionRecord, type ActionModifiedRow } from "@synchrotron/sync-core/models"
import { Cause, Chunk, Effect, Layer } from "effect"

// Choose which protocol to use
const ProtocolLive = RpcClient.layerProtocolHttp({
	url: "http://localhost:3010/rpc"
}).pipe(
	Layer.provide([
		// use fetch for http requests
		FetchHttpClient.layer,
		// use ndjson for serialization
		RpcSerialization.layerJson
	])
)

export const SyncNetworkServiceLive = Layer.scoped(
	SyncNetworkService,
	Effect.gen(function* (_) {
		const clockService = yield* ClockService
		const clientId = yield* clockService.getNodeId
		// Get the RPC client instance using the schema
		const client = yield* RpcClient.make(SyncNetworkRpcGroup)
		const sql = yield* PgLiteClient.PgLiteClient

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
				const lastSyncedClock = yield* clockService.getLastSyncedClock
				yield* Effect.logInfo(`got lastSyncedClock fetching from remote`, lastSyncedClock)
				const actions = yield* client.FetchRemoteActions({ clientId, lastSyncedClock })
				yield* Effect.logInfo(
					`fetched remote actions ${actions.actions.length} actions and ${actions.modifiedRows.length} AMRs`
				)
				yield* Effect.all(
					actions.actions.map(
						(a) => sql`insert into action_records ${sql.insert(a as any)} ON CONFLICT DO NOTHING`
					)
				)
				yield* Effect.all(
					actions.modifiedRows.map(
						(a) =>
							sql`insert into action_modified_rows ${sql.insert(a as any)} ON CONFLICT DO NOTHING`
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
