import {
	FetchRemoteActions,
	SendLocalActions,
	SyncNetworkRpcGroup,
} from "@synchrotron/sync-core/SyncNetworkRpc"
import { Effect } from "effect"
import {
	ServerConflictError,
	ServerInternalError,
	SyncServerService,
} from "./SyncServerService"
import { NetworkRequestError, RemoteActionFetchError } from "@synchrotron/sync-core/src/SyncNetworkService"

export const SyncNetworkRpcHandlersLive = SyncNetworkRpcGroup.toLayer(
	Effect.gen(function* (_) {
		const serverService = yield* _(SyncServerService);

		const FetchRemoteActionsHandler = (
			payload: FetchRemoteActions,
		) =>
			Effect.gen(function* (_) {
				const clientId = payload.clientId;

				const result = yield* _(
					serverService.getActionsSince(
						clientId,
						payload.lastSyncedClock,
					),
				);

				return { actions: result.actions, modifiedRows: result.modifiedRows };
			}).pipe(
				Effect.catchTag("ServerInternalError", (e: ServerInternalError) =>
					Effect.fail(new RemoteActionFetchError({
						message: `Server internal error fetching actions: ${e.message}`,
						cause: e.cause,
					}))
				),
				Effect.withSpan("RpcHandler.FetchRemoteActions"),
			);

		const SendLocalActionsHandler = (
			payload: SendLocalActions,
		) =>
			Effect.gen(function* (_) {
				const clientId = payload.clientId;

				yield* _(
					serverService.receiveActions(
						clientId,
						payload.actions,
						payload.amrs,
					),
				);

				return true;
			}).pipe(
				Effect.catchTags({
					ServerConflictError: (e: ServerConflictError) =>
						Effect.fail(new NetworkRequestError({
							message: `Conflict receiving actions: ${e.message}`,
							cause: e,
						})),
					ServerInternalError: (e: ServerInternalError) =>
						Effect.fail(new NetworkRequestError({
							message: `Server internal error receiving actions: ${e.message}`,
							cause: e.cause,
						}))
				}),
				Effect.withSpan("RpcHandler.SendLocalActions"),
			);

		return {
			FetchRemoteActions: FetchRemoteActionsHandler,
			SendLocalActions: SendLocalActionsHandler,
		};
	})
);

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
 * import { SyncNetworkRpcHandlersLive } from "./rpcRouter"; // Import the handler layer
 *
 * const RpcAppLive = RpcServer.layer(SyncNetworkRpcGroup).pipe( // Use the RpcGroup
 *      Layer.provide(SyncNetworkRpcHandlersLive), // Provide the handlers
 *      Layer.provide(SyncServerServiceLive) // Provide the dependency
 *      // Add serialization layer (e.g., RpcSerialization.layerJson)
 *  );
 *
 * const HttpAppLive = HttpRouter.empty.pipe(
 *   HttpRouter.rpc(RpcAppLive, { path: "/api/sync/rpc" }), // Mount RPC app
 *   HttpServer.serve(),
 *   Layer.provide(NodeHttpServer.layer(...)) // Provide HTTP server impl
 * );
 *
 */