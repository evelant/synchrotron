import { HttpRouter } from "@effect/platform"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { RpcSerialization, RpcServer } from "@effect/rpc"
import { SyncNetworkRpcGroup } from "@synchrotron/sync-core/SyncNetworkRpc"
import { SyncNetworkRpcHandlersLive } from "@synchrotron/sync-server/rpcRouter"
import { Layer, LogLevel, Logger } from "effect"
import { setupDatabase } from "./db/setup"

const SetupDbLive = Layer.scopedDiscard(setupDatabase)

// Choose the protocol and serialization format
const HttpProtocol = RpcServer.layerProtocolHttp({
	path: "/rpc"
}).pipe(Layer.provide(RpcSerialization.layerNdjson))

// Create the RPC server layer
const RpcLayer = RpcServer.layer(SyncNetworkRpcGroup).pipe(
	Layer.provideMerge(SetupDbLive),

	Layer.provideMerge(SyncNetworkRpcHandlersLive),
	Layer.provideMerge(HttpProtocol),
	Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Debug))
)

const Main = HttpRouter.Default.serve().pipe(
	Layer.provide(RpcLayer),
	Layer.provide(BunHttpServer.layer({ port: 3010 }))
)

BunRuntime.runMain(Layer.launch(Main))
