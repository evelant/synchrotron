import type { Headers as PlatformHeaders } from "@effect/platform/Headers"
import { HLC } from "@synchrotron/sync-core/HLC"
import type { HLC as HLCType } from "@synchrotron/sync-core/HLC"
import type { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"
import type {
	FetchBootstrapSnapshot,
	FetchRemoteActions,
	SendLocalActions
} from "@synchrotron/sync-core/SyncNetworkRpc"
import { SyncRpcAuthMiddleware, SyncNetworkRpcGroup } from "@synchrotron/sync-core/SyncNetworkRpc"
import type { FetchRemoteActionsCompacted } from "@synchrotron/sync-core/SyncNetworkService"
import {
	RemoteActionFetchError,
	type SendLocalActionsFailure,
	SendLocalActionsDenied
} from "@synchrotron/sync-core/SyncNetworkService"
import { Cause, Effect, Layer } from "effect"
import { SyncAuthService } from "./SyncAuthService"
import type { ServerInternalError } from "./SyncServerService"
import { SyncServerService } from "./SyncServerService"
import { SyncUserId, type UserId } from "./SyncUserId"

export const SyncNetworkRpcHandlersLive = SyncNetworkRpcGroup.toLayer(
	Effect.gen(function* () {
		const serverService = yield* SyncServerService
		const auth = yield* SyncAuthService

		const FetchRemoteActionsHandler = (
			payload: FetchRemoteActions,
			options: { readonly headers: PlatformHeaders }
		): Effect.Effect<
			{
				readonly serverEpoch: string
				readonly minRetainedServerIngestId: number
				readonly actions: readonly ActionRecord[]
				readonly modifiedRows: readonly ActionModifiedRow[]
			},
			RemoteActionFetchError | FetchRemoteActionsCompacted,
			never
		> =>
			Effect.gen(function* (_) {
				const clientId = payload.clientId
				const userId = (yield* auth.requireUserId(options.headers).pipe(
					Effect.mapError(
						(e) =>
							new RemoteActionFetchError({
								message: e.message,
								cause: e.cause
							})
					)
				)) as UserId

				yield* Effect.logInfo("rpc.FetchRemoteActions.start", {
					userId,
					clientId,
					sinceServerIngestId: payload.sinceServerIngestId,
					includeSelf: payload.includeSelf ?? false
				})
				const result = yield* serverService
					.getActionsSince(clientId, payload.sinceServerIngestId, payload.includeSelf ?? false)
					.pipe(Effect.provideService(SyncUserId, userId))

				yield* Effect.logDebug("rpc.FetchRemoteActions.result", {
					userId,
					clientId,
					serverEpoch: result.serverEpoch,
					minRetainedServerIngestId: result.minRetainedServerIngestId,
					actionCount: result.actions.length,
					amrCount: result.modifiedRows.length,
					firstActionId: result.actions[0]?.id ?? null
				})

				// return { actions: [], modifiedRows: [] }
				return {
					serverEpoch: result.serverEpoch,
					minRetainedServerIngestId: result.minRetainedServerIngestId,
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

		const FetchBootstrapSnapshotHandler = (
			payload: FetchBootstrapSnapshot,
			options: { readonly headers: PlatformHeaders }
		): Effect.Effect<
			{
				readonly serverEpoch: string
				readonly minRetainedServerIngestId: number
				readonly serverIngestId: number
				readonly serverClock: HLCType
				readonly tables: ReadonlyArray<{
					readonly tableName: string
					readonly rows: ReadonlyArray<Record<string, unknown>>
				}>
			},
			RemoteActionFetchError,
			never
		> =>
			Effect.gen(function* () {
				const clientId = payload.clientId
				const userId = (yield* auth.requireUserId(options.headers).pipe(
					Effect.mapError(
						(e) =>
							new RemoteActionFetchError({
								message: e.message,
								cause: e.cause
							})
					)
				)) as UserId

				yield* Effect.logInfo("rpc.FetchBootstrapSnapshot.start", { userId, clientId })

				const snapshot = yield* serverService
					.getBootstrapSnapshot(clientId)
					.pipe(Effect.provideService(SyncUserId, userId))

				yield* Effect.logDebug("rpc.FetchBootstrapSnapshot.result", {
					userId,
					clientId,
					serverEpoch: snapshot.serverEpoch,
					minRetainedServerIngestId: snapshot.minRetainedServerIngestId,
					serverIngestId: snapshot.serverIngestId,
					tableCount: snapshot.tables.length
				})

				return {
					serverEpoch: snapshot.serverEpoch,
					minRetainedServerIngestId: snapshot.minRetainedServerIngestId,
					serverIngestId: snapshot.serverIngestId,
					serverClock: HLC.make(snapshot.serverClock),
					tables: snapshot.tables
				}
			}).pipe(
				Effect.tapErrorCause((c) =>
					Effect.logError("rpc.FetchBootstrapSnapshot.error", { cause: Cause.pretty(c) })
				),
				Effect.catchTag("ServerInternalError", (e: ServerInternalError) =>
					Effect.fail(
						new RemoteActionFetchError({
							message: `Server internal error fetching bootstrap snapshot: ${e.message}`,
							cause: e.cause
						})
					)
				),
				Effect.annotateLogs({ rpcMethod: "FetchBootstrapSnapshot", clientId: payload.clientId }),
				Effect.withSpan("RpcHandler.FetchBootstrapSnapshot")
			)

		const SendLocalActionsHandler = (
			payload: SendLocalActions,
			options: { readonly headers: PlatformHeaders }
		): Effect.Effect<boolean, SendLocalActionsFailure, never> =>
			Effect.gen(function* (_) {
				const clientId = payload.clientId
				const userId = (yield* auth.requireUserId(options.headers).pipe(
					Effect.mapError(
						(e) =>
							new SendLocalActionsDenied({
								message: e.message
							})
					)
				)) as UserId

				yield* Effect.logInfo("rpc.SendLocalActions.start", {
					userId,
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

				yield* serverService
					.receiveActions(clientId, payload.basisServerIngestId, payload.actions, payload.amrs)
					.pipe(Effect.provideService(SyncUserId, userId))

				yield* Effect.logInfo("rpc.SendLocalActions.success", {
					userId,
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
				Effect.annotateLogs({ rpcMethod: "SendLocalActions", clientId: payload.clientId }),
				Effect.withSpan("RpcHandler.SendLocalActions")
			)

		return {
			FetchBootstrapSnapshot: FetchBootstrapSnapshotHandler,
			FetchRemoteActions: FetchRemoteActionsHandler,
			SendLocalActions: SendLocalActionsHandler
		}
	})
).pipe(
	Layer.tapErrorCause((e) => Effect.logError(`error in SyncNetworkRpcHandlersLive`, e)),
	Layer.provideMerge(
		Layer.succeed(
			SyncRpcAuthMiddleware,
			SyncRpcAuthMiddleware.of(() => Effect.void)
		)
	),
	Layer.provideMerge(SyncServerService.Default),
	Layer.provideMerge(SyncAuthService.Default)
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
