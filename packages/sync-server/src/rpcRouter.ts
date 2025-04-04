import {
	FetchRemoteActions,
	SendLocalActions,
	SyncNetworkRpcGroup
} from "@synchrotron/sync-core/SyncNetworkRpc"
import { Effect, Layer } from "effect"
import { ServerConflictError, ServerInternalError, SyncServerService } from "./SyncServerService"
import {
	NetworkRequestError,
	RemoteActionFetchError
} from "@synchrotron/sync-core/SyncNetworkService"
import { KeyValueStore } from "@effect/platform"
import { PgClientLive } from "@synchrotron/sync-server/db/connection"

export const SyncNetworkRpcHandlersLive = SyncNetworkRpcGroup.toLayer(
	Effect.gen(function* () {
		const serverService = yield* SyncServerService

		const FetchRemoteActionsHandler = (payload: FetchRemoteActions) =>
			Effect.gen(function* (_) {
				const clientId = payload.clientId

				const result = yield* serverService.getActionsSince(clientId, payload.lastSyncedClock)

				return { actions: result.actions, modifiedRows: result.modifiedRows }
			}).pipe(
				Effect.catchTag("ServerInternalError", (e: ServerInternalError) =>
					Effect.fail(
						new RemoteActionFetchError({
							message: `Server internal error fetching actions: ${e.message}`,
							cause: e.cause
						})
					)
				),
				Effect.withSpan("RpcHandler.FetchRemoteActions")
			)

		const SendLocalActionsHandler = (payload: SendLocalActions) =>
			Effect.gen(function* (_) {
				const clientId = payload.clientId

				yield* serverService.receiveActions(clientId, payload.actions, payload.amrs)

				return true
			}).pipe(
				Effect.catchTags({
					ServerConflictError: (e: ServerConflictError) =>
						Effect.fail(
							new NetworkRequestError({
								message: `Conflict receiving actions: ${e.message}`,
								cause: e
							})
						),
					ServerInternalError: (e: ServerInternalError) =>
						Effect.fail(
							new NetworkRequestError({
								message: `Server internal error receiving actions: ${e.message}`,
								cause: e.cause
							})
						)
				}),
				Effect.withSpan("RpcHandler.SendLocalActions")
			)

		return {
			FetchRemoteActions: FetchRemoteActionsHandler,
			SendLocalActions: SendLocalActionsHandler
		}
	})
).pipe(
	Layer.provideMerge(SyncServerService.Default),
	Layer.provideMerge(KeyValueStore.layerMemory),
	Layer.provideMerge(PgClientLive)
)

/*
 * Conceptual Integration Point:
 * This SyncNetworkRpcHandlersLive layer would typically be merged with
 * an HttpRouter layer and served via an HttpServer in `packages/sync-server/src/index.ts`
 * or a similar entry point.
 *
 * Example (Conceptual):
 *
 * import { HttpRouter, HttpServer } from "@effect/platform";
 * import { NodeHttpServer } from "@effect/platform-node";
 * import { RpcServer } from "@effect/rpc";
 * import { SyncServerServiceLive } from "./SyncServerService";
 * import { SyncNetworkRpcHandlersLive } from "./rpcRouter";
 *
 * const RpcAppLive = RpcServer.layer(SyncNetworkRpcGroup).pipe(
 *      Layer.provide(SyncNetworkRpcHandlersLive),
 *      Layer.provide(SyncServerServiceLive)
 *  );
 *
 * const HttpAppLive = HttpRouter.empty.pipe(
 *   HttpRouter.rpc(RpcAppLive, { path: "/api/sync/rpc" }),
 *   HttpServer.serve(),
 *   Layer.provide(NodeHttpServer.layer(...))
 * );
 *
 */
