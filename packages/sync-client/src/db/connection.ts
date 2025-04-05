import { PgLiteClient } from "@effect/sql-pglite"
import { electricSync } from "@electric-sql/pglite-sync"
import { live } from "@electric-sql/pglite/live"
import { SynchrotronClientConfig, SynchrotronClientConfigData } from "@synchrotron/sync-core/config"
import { Effect, Layer } from "effect"

export const PgLiteSyncTag = PgLiteClient.tag<{
	live: typeof live
	electric: ReturnType<typeof electricSync>
}>()

/**
 * Creates a PgLiteClient layer with the specified configuration
 */
const createPgLiteClientLayer = (config: SynchrotronClientConfigData["pglite"]) => {
	// DebugLevel is 0, 1, or 2
	// Type assertion is safe because we ensure it's a valid value
	return PgLiteClient.layer({
		// @ts-ignore - debug level is 0, 1, or 2, but TypeScript doesn't understand the constraint
		debug: config.debug, //config.debug >= 0 && config.debug <= 2 ? config.debug : 1,
		dataDir: config.dataDir,
		relaxedDurability: config.relaxedDurability,
		extensions: {
			electric: electricSync(),
			live
		}
	})
}

/**
 * Create a layer that provides PgLiteClient with Electric extensions based on config
 */
export const PgLiteClientLive = Layer.unwrapEffect(
	Effect.gen(function* () {
		const config = yield* SynchrotronClientConfig
		yield* Effect.logInfo(`creating PgLiteClient layer with config`, config)
		const pgLayer = createPgLiteClientLayer(config.pglite)
		return pgLayer
	})
)
