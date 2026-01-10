import { HttpMiddleware, HttpRouter, HttpServer, HttpServerRequest } from "@effect/platform"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { RpcMiddleware, RpcSerialization, RpcServer } from "@effect/rpc"
import { SyncNetworkRpcGroup } from "@synchrotron/sync-core/SyncNetworkRpc"
import { PgClientLive } from "@synchrotron/sync-server/db/connection"
import { SyncNetworkRpcHandlersLive } from "@synchrotron/sync-server/rpcRouter"
import { Cause, Effect, flow, Layer, Logger, LogLevel, Schema } from "effect"
import { setupDatabase } from "./db/setup"

const SetupDbLive = Layer.scopedDiscard(setupDatabase)

// Define a schema for errors returned by the logger middleware
class LoggerError extends Schema.TaggedError<LoggerError>()("LoggerError", {}) {}

// Extend the HttpApiMiddleware.Tag class to define the logger middleware tag
class MyLogger extends RpcMiddleware.Tag<MyLogger>()("Http/Logger", {
	// Optionally define the error schema for the middleware
	failure: LoggerError
}) {}

const HttpProtocol = RpcServer.layerProtocolHttp({
	path: "/rpc"
}).pipe(Layer.provideMerge(RpcSerialization.layerJson))

// Create the RPC server layer
const RpcLayer = RpcServer.layer(SyncNetworkRpcGroup).pipe(
	Layer.provideMerge(SetupDbLive),

	Layer.provideMerge(SyncNetworkRpcHandlersLive),
	Layer.provideMerge(HttpProtocol),
	Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Debug))
)

const makeRpcApp = RpcServer.toHttpApp(SyncNetworkRpcGroup).pipe(
	Effect.provide(SetupDbLive),
	Effect.provide(HttpProtocol),
	Effect.provide(SyncNetworkRpcHandlersLive),
	Logger.withMinimumLogLevel(LogLevel.Trace)
)
const makeRouter = Effect.gen(function* () {
	const rpcApp = yield* makeRpcApp
	const router = HttpRouter.empty.pipe(
		HttpRouter.mountApp("/rpc", rpcApp),
		HttpRouter.use(HttpMiddleware.logger),
		HttpRouter.use(
			HttpMiddleware.cors({
				allowedOrigins: ["*"],
				allowedMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
			})
		),
		Effect.tap((r) => Effect.logInfo(`response: ${JSON.stringify(r)}`)),
		Effect.tapErrorCause((c) => Effect.logError(`Error in router: ${Cause.pretty(c)}`))
	)
	return router
})
const myLogger = HttpMiddleware.make((app) =>
	Effect.gen(function* () {
		const req = yield* HttpServerRequest.HttpServerRequest

		return yield* app
	})
)
const middlewares = flow(
	HttpMiddleware.cors({
		allowedOrigins: ["*"],
		allowedMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
	}),
	HttpMiddleware.logger
)
const Main2 = Effect.gen(function* () {
	const router = yield* makeRouter
	return HttpServer.serve(router).pipe(Layer.provide(BunHttpServer.layer({ port: 3010 })))
}).pipe(Layer.unwrapEffect, Layer.provideMerge(PgClientLive))

const Main = HttpRouter.Default.serve(middlewares).pipe(
	Layer.provide(RpcLayer),
	Layer.provide(BunHttpServer.layer({ port: 3010 }))
)

BunRuntime.runMain(Layer.launch(Main2).pipe(Effect.scoped))
