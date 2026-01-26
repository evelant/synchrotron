import { PgliteClient } from "@effect/sql-pglite"
import { electricSync } from "@electric-sql/pglite-sync"
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp"
import { live } from "@electric-sql/pglite/live"
import type { SynchrotronClientConfigData } from "@synchrotron/sync-core/config"
import { SynchrotronClientConfig } from "@synchrotron/sync-core/config"
import { Effect, Layer } from "effect"

export const PgLiteSyncTag = PgliteClient.tag<{
	live: typeof live
	electric: ReturnType<typeof electricSync>
	uuid_ossp: typeof uuid_ossp
}>()

/**
 * Creates a PgliteClient layer with the specified configuration
 */
const createPgliteClientLayer = (config: SynchrotronClientConfigData["pglite"]) => {
	const isDebugLevel = (value: number): value is 0 | 1 | 2 =>
		value === 0 || value === 1 || value === 2
	const debug = isDebugLevel(config.debug) ? config.debug : 0

	// DebugLevel is 0, 1, or 2
	// Type assertion is safe because we ensure it's a valid value
	return PgliteClient.layer({
		debug,
		dataDir: config.dataDir,
		relaxedDurability: config.relaxedDurability,
		extensions: {
			electric: electricSync(),
			live,
			uuid_ossp
		}
	})
}

/**
 * Create a layer that provides PgliteClient with Electric extensions based on config
 */
export const PgliteClientLive = Layer.unwrapEffect(
	Effect.gen(function* () {
		const config = yield* SynchrotronClientConfig
		yield* Effect.logInfo("db.pglite.clientLayer.create", {
			dataDir: config.pglite.dataDir,
			debug: config.pglite.debug,
			relaxedDurability: config.pglite.relaxedDurability
		})
		const pgLayer = createPgliteClientLayer(config.pglite)
		return pgLayer
	})
)
