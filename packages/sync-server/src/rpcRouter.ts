import { KeyValueStore } from "@effect/platform"
import { HLC } from "@synchrotron/sync-core/HLC"
import {
	FetchRemoteActions,
	SendLocalActions,
	SyncNetworkRpcGroup
} from "@synchrotron/sync-core/SyncNetworkRpc"
import {
	NetworkRequestError,
	RemoteActionFetchError
} from "@synchrotron/sync-core/SyncNetworkService"
import { Cause, Effect, Layer } from "effect"
import { ServerConflictError, ServerInternalError, SyncServerService } from "./SyncServerService"

export const SyncNetworkRpcHandlersLive = SyncNetworkRpcGroup.toLayer(
	Effect.gen(function* () {
		const serverService = yield* SyncServerService

		const FetchRemoteActionsHandler = (payload: FetchRemoteActions) =>
			Effect.gen(function* (_) {
				const clientId = payload.clientId

				yield* Effect.logInfo("rpc.FetchRemoteActions.start", {
					clientId,
					sinceServerIngestId: payload.sinceServerIngestId
				})
				const result = yield* serverService.getActionsSince(clientId, payload.sinceServerIngestId)

				yield* Effect.logDebug("rpc.FetchRemoteActions.result", {
					clientId,
					actionCount: result.actions.length,
					amrCount: result.modifiedRows.length,
					firstActionId: result.actions[0]?.id ?? null
				})

				// return { actions: [], modifiedRows: [] }
				return {
					actions: result.actions.map((a) => ({ ...a, clock: HLC.make(a.clock) })),
					// actions: [],
					modifiedRows: result.modifiedRows
				}
			}).pipe(
				Effect.tapErrorCause((c) =>
					Effect.logError("rpc.FetchRemoteActions.error", { cause: Cause.pretty(c) })
				),
				Effect.catchTag("ServerInternalError", (e: ServerInternalError) =>
					Effect.fail(
						new RemoteActionFetchError({
							message: `Server internal error fetching actions: ${e.message}`,
							cause: e.cause
						})
					)
				),
				Effect.annotateLogs({ rpcMethod: "FetchRemoteActions", clientId: payload.clientId }),
				Effect.withSpan("RpcHandler.FetchRemoteActions")
			)

			const SendLocalActionsHandler = (payload: SendLocalActions) =>
				Effect.gen(function* (_) {
					const clientId = payload.clientId

					yield* Effect.logInfo("rpc.SendLocalActions.start", {
						clientId,
						basisServerIngestId: payload.basisServerIngestId,
						actionCount: payload.actions.length,
						amrCount: payload.amrs.length,
						actionTags: payload.actions.reduce<Record<string, number>>((acc, a) => {
							acc[a._tag] = (acc[a._tag] ?? 0) + 1
							return acc
						}, {}),
						hasSyncDelta: payload.actions.some((a) => a._tag === "_InternalSyncApply")
					})

					yield* serverService.receiveActions(
						clientId,
						payload.basisServerIngestId,
						payload.actions,
						payload.amrs
					)

					yield* Effect.logInfo("rpc.SendLocalActions.success", {
						clientId,
						basisServerIngestId: payload.basisServerIngestId,
						actionCount: payload.actions.length,
						amrCount: payload.amrs.length
					})

					return true
			}).pipe(
				Effect.tapErrorCause((c) =>
					Effect.logError("rpc.SendLocalActions.error", { cause: Cause.pretty(c) })
				),
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
				Effect.annotateLogs({ rpcMethod: "SendLocalActions", clientId: payload.clientId }),
				Effect.withSpan("RpcHandler.SendLocalActions")
			)

		return {
			FetchRemoteActions: FetchRemoteActionsHandler,
			SendLocalActions: SendLocalActionsHandler
		}
	})
).pipe(
	Layer.tapErrorCause((e) => Effect.logError(`error in SyncNetworkRpcHandlersLive`, e)),
	Layer.provideMerge(SyncServerService.Default),
	Layer.provideMerge(KeyValueStore.layerMemory)
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
