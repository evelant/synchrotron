import { HttpMiddleware, HttpRouter } from "@effect/platform"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { RpcSerialization, RpcServer } from "@effect/rpc"
import { SyncNetworkRpcGroup } from "@synchrotron/sync-core/SyncNetworkRpc"
import { SyncNetworkRpcHandlersLive } from "@synchrotron/sync-server/rpcRouter"
import { Effect, Layer, LogLevel, Logger } from "effect"
import { setupDatabase } from "./db/setup"

const SetupDbLive = Layer.scopedDiscard(setupDatabase)

// Choose the protocol and serialization format
const HttpProtocol = RpcServer.layerProtocolHttp({
	path: "/rpc"
}).pipe(Layer.provide(RpcSerialization.layerJson))

// Create the RPC server layer
const RpcLayer = RpcServer.layer(SyncNetworkRpcGroup.pipe()).pipe(
	Layer.provideMerge(SetupDbLive),

	Layer.provideMerge(SyncNetworkRpcHandlersLive),
	Layer.provideMerge(HttpProtocol),
	Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Debug))
)
const rpcHttpApp = RpcServer.toHttpApp(SyncNetworkRpcGroup).pipe(Effect.provide(RpcLayer))
const _main = HttpRouter.empty.pipe(
	HttpMiddleware.logger,
	HttpMiddleware.cors({
		allowedOrigins: ["*"],
		allowedMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
	})
)

const Main = HttpRouter.Default.serve(
	HttpMiddleware.logger
	// HttpMiddleware.cors({
	// 	allowedOrigins: ["*"],
	// 	allowedMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
	// })
).pipe(Layer.provide(RpcLayer), Layer.provide(BunHttpServer.layer({ port: 3010 })))

BunRuntime.runMain(Layer.launch(Main) as any)
