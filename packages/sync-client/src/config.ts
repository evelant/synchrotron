import { Config, Context, Effect, Layer, Option } from "effect"

/**
 * Default configuration values
 */
export const defaultConfig = {
	electricSyncUrl: "http://localhost:5133",
	syncRpcUrl: "http://localhost:3010/rpc",
	syncRpcAuthToken: undefined as string | undefined,
	pglite: {
		debug: 0,
		dataDir: "idb://synchrotron",
		relaxedDurability: true
	}
}

/**
 * Configuration schema for the Synchrotron client.
 *
 * We keep it as a single `Config<...>` so downstream code can get the inferred
 * TypeScript type via `Config.Config.Success<typeof synchrotronClientConfig>`.
 */
export const synchrotronClientConfig = Config.unwrap({
	electricSyncUrl: Config.string("ELECTRIC_SYNC_URL").pipe(
		Config.withDefault(defaultConfig.electricSyncUrl)
	),
	syncRpcAuthToken: Config.string("SYNC_RPC_AUTH_TOKEN").pipe(Config.option),
	syncRpcUrl: Config.string("SYNC_RPC_URL").pipe(Config.withDefault(defaultConfig.syncRpcUrl)),
	pglite: Config.unwrap({
		debug: Config.number("PGLITE_DEBUG").pipe(Config.withDefault(defaultConfig.pglite.debug)),
		dataDir: Config.string("PGLITE_DATA_DIR").pipe(
			Config.withDefault(defaultConfig.pglite.dataDir)
		),
		relaxedDurability: Config.boolean("PGLITE_RELAXED_DURABILITY").pipe(
			Config.withDefault(defaultConfig.pglite.relaxedDurability)
		)
	})
}).pipe(
	Config.map((config) => ({
		...config,
		syncRpcAuthToken: Option.getOrUndefined(config.syncRpcAuthToken)
	}))
)

export type SynchrotronClientConfigData = Config.Config.Success<typeof synchrotronClientConfig>

export class SynchrotronClientConfig extends Context.Tag("SynchrotronClientConfig")<
	SynchrotronClientConfig,
	SynchrotronClientConfigData
>() {}

/**
 * Layer that provides the config from environment variables
 */
export const SynchrotronConfigLive = Layer.effect(
	SynchrotronClientConfig,
	Effect.gen(function* () {
		return yield* synchrotronClientConfig
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
		syncRpcAuthToken:
			typeof config.syncRpcAuthToken === "string"
				? config.syncRpcAuthToken
				: defaultConfig.syncRpcAuthToken,
		pglite: {
			...defaultConfig.pglite,
			...(config.pglite ?? {})
		}
	}

	return Layer.succeed(SynchrotronClientConfig, mergedConfig)
}
