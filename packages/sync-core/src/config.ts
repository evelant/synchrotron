import { Config, Context, Effect, Layer } from "effect"

export interface SynchrotronClientConfigData {
	/**
	 * Base URL for Electric sync service
	 */
	electricSyncUrl: string
	/**
	 * Configuration for PGlite database
	 */
	pglite: {
		/**
		 * Debug level (0-2)
		 */
		debug: number
		/**
		 * Data directory path
		 */
		dataDir: string
		/**
		 * Whether to use relaxed durability for better performance
		 */
		relaxedDurability: boolean
	}
}

export class SynchrotronClientConfig extends Context.Tag("SynchrotronClientConfig")<
	SynchrotronClientConfig,
	SynchrotronClientConfigData
>() {}

/**
 * Default configuration values
 */
export const defaultConfig: SynchrotronClientConfigData = {
	electricSyncUrl: "http://localhost:5133",
	pglite: {
		debug: 1,
		dataDir: "idb://synchrotron",
		relaxedDurability: true
	}
}

/**
 * Configuration schema for the Synchrotron client
 */
export const synchrotronClientConfig = {
	electricSyncUrl: Config.string("ELECTRIC_SYNC_URL").pipe(
		Config.withDefault(defaultConfig.electricSyncUrl)
	),
	pglite: {
		debug: Config.number("PGLITE_DEBUG").pipe(Config.withDefault(defaultConfig.pglite.debug)),
		dataDir: Config.string("PGLITE_DATA_DIR").pipe(
			Config.withDefault(defaultConfig.pglite.dataDir)
		),
		relaxedDurability: Config.boolean("PGLITE_RELAXED_DURABILITY").pipe(
			Config.withDefault(defaultConfig.pglite.relaxedDurability)
		)
	}
}

/**
 * Layer that provides the config from environment variables
 */
export const SynchrotronConfigLive = Layer.effect(
	SynchrotronClientConfig,
	Effect.gen(function* () {
		const electricSyncUrl = yield* synchrotronClientConfig.electricSyncUrl
		const debug = yield* synchrotronClientConfig.pglite.debug
		const dataDir = yield* synchrotronClientConfig.pglite.dataDir
		const relaxedDurability = yield* synchrotronClientConfig.pglite.relaxedDurability

		return {
			electricSyncUrl,
			pglite: {
				debug,
				dataDir,
				relaxedDurability
			}
		}
	})
)

/**
 * Create a config layer with explicit values
 */
export const createSynchrotronConfig = (
	config: Partial<SynchrotronClientConfigData>
): Layer.Layer<SynchrotronClientConfig, never> => {
	const mergedConfig = {
		...defaultConfig,
		...config,
		pglite: {
			...defaultConfig.pglite,
			...(config.pglite || {})
		}
	}

	return Layer.succeed(SynchrotronClientConfig, mergedConfig)
}
