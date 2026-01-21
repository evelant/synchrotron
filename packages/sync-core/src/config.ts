import { Config, Context, Effect, Layer, Option } from "effect"

export interface SynchrotronClientConfigData {
	/**
	 * Base URL for Electric sync service
	 */
	electricSyncUrl: string
	/**
	 * Optional bearer token for the RPC transport (`Authorization: Bearer ...`).
	 *
	 * When provided, the server should verify the token and derive `user_id` for RLS.
	 */
	syncRpcAuthToken?: string
	/**
	 * HTTP URL for Synchrotron's RPC sync endpoint (used by `SyncNetworkServiceLive`).
	 *
	 * Example: `http://localhost:3010/rpc`
	 */
	syncRpcUrl: string
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
	syncRpcUrl: "http://localhost:3010/rpc",
	pglite: {
		debug: 0,
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
	syncRpcAuthToken: Config.string("SYNC_RPC_AUTH_TOKEN").pipe(Config.option),
	syncRpcUrl: Config.string("SYNC_RPC_URL").pipe(Config.withDefault(defaultConfig.syncRpcUrl)),
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
		const syncRpcAuthToken = yield* synchrotronClientConfig.syncRpcAuthToken
		const syncRpcUrl = yield* synchrotronClientConfig.syncRpcUrl
		const debug = yield* synchrotronClientConfig.pglite.debug
		const dataDir = yield* synchrotronClientConfig.pglite.dataDir
		const relaxedDurability = yield* synchrotronClientConfig.pglite.relaxedDurability

		return {
			electricSyncUrl,
			syncRpcUrl,
			pglite: {
				debug,
				dataDir,
				relaxedDurability
			},
			...(Option.isSome(syncRpcAuthToken)
				? { syncRpcAuthToken: syncRpcAuthToken.value }
				: {})
		}
	})
)

/**
 * Create a config layer with explicit values
 */
export const createSynchrotronConfig = (
	config: Partial<SynchrotronClientConfigData>
): Layer.Layer<SynchrotronClientConfig, never> => {
	const mergedConfig: SynchrotronClientConfigData = {
		electricSyncUrl: config.electricSyncUrl ?? defaultConfig.electricSyncUrl,
		syncRpcUrl: config.syncRpcUrl ?? defaultConfig.syncRpcUrl,
		pglite: {
			...defaultConfig.pglite,
			...(config.pglite ?? {})
		},
		...(typeof config.syncRpcAuthToken === "string"
			? { syncRpcAuthToken: config.syncRpcAuthToken }
			: {})
	}

	return Layer.succeed(SynchrotronClientConfig, mergedConfig)
}
