import { HttpMiddleware, HttpRouter } from "@effect/platform"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { RpcSerialization, RpcServer } from "@effect/rpc"
import { SyncNetworkRpcGroup } from "@synchrotron/sync-core/SyncNetworkRpc"
import { createSyncSnapshotConfig } from "@synchrotron/sync-server/SyncSnapshotConfig"
import { PgClientLive } from "@synchrotron/sync-server/db/connection"
import { SyncNetworkRpcHandlersLive } from "@synchrotron/sync-server/rpcRouter"
import { Effect, flow, Layer, Logger, LogLevel } from "effect"

const HttpProtocol = RpcServer.layerProtocolHttp({
	path: "/rpc"
}).pipe(Layer.provideMerge(RpcSerialization.layerJson))

// Create the RPC server layer
const RpcLayer = RpcServer.layer(SyncNetworkRpcGroup).pipe(
	Layer.provideMerge(SyncNetworkRpcHandlersLive),
	Layer.provideMerge(createSyncSnapshotConfig(["todos"])),
	Layer.provideMerge(HttpProtocol),
	Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Debug))
)

const middlewares = flow(
	HttpMiddleware.cors({
		allowedOrigins: ["*"],
		allowedMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
	}),
	HttpMiddleware.logger
)
const Main = HttpRouter.Default.serve(middlewares).pipe(
	Layer.provide(RpcLayer),
	Layer.provide(PgClientLive),
	Layer.provide(BunHttpServer.layer({ port: 3010 }))
)

BunRuntime.runMain(Layer.launch(Main).pipe(Effect.scoped))
