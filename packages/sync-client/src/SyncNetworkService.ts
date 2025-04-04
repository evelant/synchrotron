import {
	SyncNetworkService,
	type ActionModifiedRow,
	type ActionRecord,
	type FetchResult,
	RemoteActionFetchError,
	NetworkRequestError,
	ClockService
} from "@synchrotron/sync-core"
import { Effect, Layer, Scope } from "effect"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { FetchHttpClient } from "@effect/platform"
import {
	FetchRemoteActions,
	SendLocalActions,
	SyncNetworkRpcGroup
} from "@synchrotron/sync-core/SyncNetworkRpc"

const SyncNetworkRpcClientProtocolLive = RpcClient.layerProtocolHttp({
	url: "/api/sync/rpc"
}).pipe(
	Layer.provide(
		Layer.merge(
			FetchHttpClient.layer,
			RpcSerialization.layerJson
		)
	)
)

/**
 * Effect constructor for the client SyncNetworkService implementation.
 */
const makeSyncNetworkServiceClient = Effect.gen(function* () {
	const clockService = yield* ClockService
	const clientId = yield* clockService.getNodeId
	const client = yield* RpcClient.make(SyncNetworkRpcGroup)

	const fetchRemoteActions = (): Effect.Effect<FetchResult, RemoteActionFetchError> =>
		Effect.gen(function* () {
			const lastSyncedClock = yield* clockService.getLastSyncedClock
			return yield* client.FetchRemoteActions({ lastSyncedClock, clientId })
		}).pipe(
			Effect.catchAll((e) =>
				Effect.fail(new RemoteActionFetchError({ message: "Failed to fetch remote actions via RPC", cause: e }))
			),
			Effect.withSpan("SyncNetworkServiceClient.fetchRemoteActions")
		)

	const sendLocalActions = (
		actionsToSend: readonly ActionRecord[],
		amrs: readonly ActionModifiedRow[]
	): Effect.Effect<boolean, NetworkRequestError> =>
		client.SendLocalActions({ actions: actionsToSend, amrs, clientId }).pipe(
			Effect.catchAll((e) =>
				Effect.fail(new NetworkRequestError({ message: "Failed to send local actions via RPC", cause: e }))
			),
			Effect.withSpan("SyncNetworkServiceClient.sendLocalActions", {
				attributes: { actionCount: actionsToSend.length, amrCount: amrs.length }
			})
		)

	// Use .of() with the explicit _tag property
	return SyncNetworkService.of({
		_tag: "SyncNetworkService",
		fetchRemoteActions,
		sendLocalActions
	})
})

/**
 * Live Layer for the client SyncNetworkService.
 * Provides the RPC implementation and its dependencies.
 */
export const SyncNetworkServiceClientLive = Layer.effect(
	SyncNetworkService,
	makeSyncNetworkServiceClient
).pipe(
	Layer.provide(
		Layer.merge(
			ClockService.Default,
			SyncNetworkRpcClientProtocolLive
		)
	)
)