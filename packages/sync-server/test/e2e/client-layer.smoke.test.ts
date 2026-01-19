import { KeyValueStore } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { describe, expect, it } from "@effect/vitest"
import { makeSynchrotronClientLayer } from "@synchrotron/sync-client"
import { ClientDbAdapter } from "@synchrotron/sync-core/ClientDbAdapter"
import { ClientIdOverride } from "@synchrotron/sync-core/ClientIdOverride"
import { Effect, Layer } from "effect"

describe("E2E client layer (smoke)", () => {
	it.scoped(
		"makeSynchrotronClientLayer provides SqlClient + ClientDbAdapter",
		() =>
			Effect.gen(function* () {
				const layer = makeSynchrotronClientLayer(
					{
						syncRpcUrl: "http://unused/rpc",
						electricSyncUrl: "http://unused",
						pglite: { dataDir: `memory://client-${crypto.randomUUID()}`, debug: 0, relaxedDurability: true }
					},
					{ keyValueStoreLayer: KeyValueStore.layerMemory.pipe(Layer.fresh) }
				).pipe(Layer.provideMerge(Layer.succeed(ClientIdOverride, "client-smoke")), Layer.provideMerge(Layer.scope))

				const context = yield* Layer.build(layer)

				const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(context))
				yield* sql`SELECT 1`

				const clientDb = yield* ClientDbAdapter.pipe(Effect.provide(context))
				expect(clientDb.dialect).toBe("postgres")
			}),
		{ timeout: 30000 }
	)
})

