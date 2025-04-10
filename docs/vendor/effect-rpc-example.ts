import { HttpRouter } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "@effect/rpc"
import { Effect, Layer, Schema } from "effect"
import { pipe } from "effect/Function"
import { createServer } from "node:http"

import { DevToolsLive } from "./DevTools"

class MyRequest extends Schema.TaggedRequest<MyRequest>()("MyRequest", {
  payload: {},
  success: Schema.Void,
  failure: Schema.Never
}) {}

class RpcList extends RpcGroup.make(
  Rpc.fromTaggedRequest(MyRequest)
) {
}

const RpcListServer = RpcList.toLayer({
  MyRequest: Effect.fn(() => Effect.void)
})

const rpcServer = Layer.mergeAll(
  RpcServer.layer(RpcList).pipe(Layer.provide(RpcListServer)),
  // more rpc group implementations
)

class Server {
  static readonly Default = pipe(
    HttpRouter.Default.serve(), // or use unwrap for adding middleware
    Layer.provide(rpcServer.pipe(Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" }).pipe(Layer.provide(RpcSerialization.layerJson))))),
    // you can add more routes via Layer.provide(HttpRouter.Default.use())
    Layer.provide(
      NodeHttpServer.layer(createServer, { port: 8080 })
    )
  )
}


NodeRuntime.runMain(Layer.launch(
  Layer.mergeAll(Server.Default, DevToolsLive)
))
