import { RpcSerialization, RpcServer } from "@effect/rpc"
import { SqlClient } from "@effect/sql"
import { describe, expect, it } from "@effect/vitest"
import { SyncNetworkRpcGroup } from "@synchrotron/sync-core/SyncNetworkRpc"
import { Effect, Layer } from "effect"
import { SyncNetworkRpcHandlersLive } from "../../src/rpcRouter"
import { makeServerSqlLayer } from "./harness"

describe("E2E in-process server runtime (smoke)", () => {
	it.scoped(
		"Layer.toRuntime(serverLayer) includes SqlClient",
		() =>
			Effect.gen(function* () {
				const dbLayer = makeServerSqlLayer(`memory://server-${crypto.randomUUID()}`)

				const servicesLayer = SyncNetworkRpcHandlersLive.pipe(Layer.provideMerge(dbLayer))
				const serverLayer = Layer.mergeAll(servicesLayer, RpcSerialization.layerJson)
				const runtime = yield* Layer.toRuntime(serverLayer)

				const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(runtime))
				yield* sql`SELECT 1`

				expect(typeof sql).toBe("function")

				// And we can build the RPC http app (which will fork the server fiber in scope).
				const httpApp = yield* RpcServer.toHttpApp(SyncNetworkRpcGroup).pipe(Effect.provide(runtime))
				expect(httpApp).toBeDefined()
			}),
		{ timeout: 30000 }
	)
})
