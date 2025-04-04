import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { SyncNetworkRpcGroup } from "@synchrotron/sync-core/SyncNetworkRpc"
import {
	NetworkRequestError,
	RemoteActionFetchError,
	SyncNetworkService
} from "@synchrotron/sync-core/SyncNetworkService"
import { ActionRecord } from "@synchrotron/sync-core/models"
import { ClockService } from "@synchrotron/sync-core/ClockService"
import { Effect, Layer } from "effect"

// Choose which protocol to use
const ProtocolLive = RpcClient.layerProtocolHttp({
	url: "http://localhost:3010/rpc"
}).pipe(
	Layer.provide([
		// use fetch for http requests
		FetchHttpClient.layer,
		// use ndjson for serialization
		RpcSerialization.layerNdjson
	])
)

export const SyncNetworkServiceLive = Layer.scoped(
	SyncNetworkService,
	Effect.gen(function* (_) {
		const clockService = yield* ClockService
		const clientId = yield* clockService.getNodeId
		// Get the RPC client instance using the schema
		const client = yield* RpcClient.make(SyncNetworkRpcGroup)

		const sendLocalActions = (actions: ReadonlyArray<ActionRecord>) =>
			Effect.gen(function* () {
				return yield* client.SendLocalActions({ actions: actions, amrs: [], clientId })
			}).pipe(
				Effect.mapError(
					(error) => new NetworkRequestError({ message: error.message, cause: error })
				)
			)
		const fetchRemoteActions = () =>
			Effect.gen(function* () {
				const lastSyncedClock = yield* clockService.getLastSyncedClock
				return yield* client.FetchRemoteActions({ clientId, lastSyncedClock })
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
