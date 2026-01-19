import { KeyValueStore } from "@effect/platform"
import { BrowserKeyValueStore } from "@effect/platform-browser"
import {
	ActionModifiedRowRepo,
	ActionRecordRepo,
	ActionRegistry,
	ClientDbAdapter,
	ClockService,
	PostgresClientDbAdapter,
	SqliteClientDbAdapter,
	SyncService
} from "@synchrotron/sync-core"
import {
	SynchrotronClientConfig,
	SynchrotronClientConfigData,
	createSynchrotronConfig
} from "@synchrotron/sync-core/config"
import { Effect, Layer } from "effect"
import { PgliteClientLive } from "./db/connection"
import { SqliteWasmClientMemoryLive } from "./db/sqlite-wasm"
import { ElectricSyncService } from "./electric/ElectricSyncService"
import { SyncNetworkServiceLive } from "./SyncNetworkService"
import { logInitialSyncDbState } from "./logInitialDbState"

/**
 * Layer that initializes the sync schema and starts Electric ingress.
 *
 * This is intentionally **not** included in `makeSynchrotronClientLayer` by default,
 * so apps can opt into Electric explicitly (and demos can implement "offline" mode
 * by simply not wiring Electric at all).
 */
export const ElectricSyncLive = Layer.unwrapEffect(
	Effect.gen(function* () {
		yield* Effect.logInfo("electric.sync.setup.start")
		const clientDbAdapter = yield* ClientDbAdapter

		// Electric ingress may write into `action_records` / `action_modified_rows`,
		// so ensure the sync schema exists before starting the stream.
		yield* clientDbAdapter.initializeSyncSchema
		yield* Effect.logInfo("electric.sync.setup.schemaReady")

		return ElectricSyncService.Default
	}).pipe(Effect.withSpan("ElectricSyncLive"))
)

/**
 * Creates a fully configured Synchrotron client layer with custom configuration
 *
 * @example
 * ```ts
 * // Create a custom configured client
 * const customClient = makeSynchrotronClientLayer({
 *   electricSyncUrl: "https://my-sync-server.com",
 *   pglite: {
 *     dataDir: "idb://my-custom-db"
 *   }
 * })
 * ```
 */
export const makeSynchrotronClientLayer = (
	config: Partial<SynchrotronClientConfigData> = {},
	options?: {
		readonly keyValueStoreLayer?: Layer.Layer<KeyValueStore.KeyValueStore>
	}
) => {
	// Create the config layer with custom config merged with defaults
	const configLayer = createSynchrotronConfig(config)
	const keyValueStoreLayer = options?.keyValueStoreLayer ?? BrowserKeyValueStore.layerLocalStorage

	// Note: Electric is intentionally optional. Do not start Electric replication
	// unless the consumer explicitly adds `ElectricSyncLive` (preferred) to their app layer.
	// (If you wire `ElectricSyncService.Default` directly, ensure the sync schema is initialized first.)
	return SyncService.Default.pipe(
		// Highest-level services first, core dependencies last.
		// `Layer.provideMerge` wraps previously-added layers, so later layers are available to earlier ones.
		Layer.provideMerge(SyncNetworkServiceLive),
		Layer.provideMerge(ActionRegistry.Default),
		Layer.provideMerge(ClockService.Default),
		Layer.provideMerge(ActionRecordRepo.Default),
		Layer.provideMerge(ActionModifiedRowRepo.Default),
		Layer.provideMerge(keyValueStoreLayer),
		Layer.provideMerge(PostgresClientDbAdapter),
		Layer.provideMerge(PgliteClientLive),
		Layer.provideMerge(
			Layer.effectDiscard(
				Effect.gen(function* () {
					const cfg = yield* SynchrotronClientConfig
					yield* Effect.logInfo("synchrotron.client.start", {
						platform: "browser-pglite",
						userId: cfg.userId ?? null,
						hasSyncRpcAuthToken:
							typeof cfg.syncRpcAuthToken === "string" && cfg.syncRpcAuthToken.length > 0,
						electricSyncUrl: cfg.electricSyncUrl,
						syncRpcUrl: cfg.syncRpcUrl,
						pgliteDataDir: cfg.pglite.dataDir
					})
				})
			)
		),
		Layer.provideMerge(configLayer),
		Layer.tap((context) => logInitialSyncDbState.pipe(Effect.provide(context)))
	)
}

/**
 * SQLite (WASM) client layer (no Electric integration).
 *
 * Intended for environments where PGlite is unavailable (or undesirable) and a stable SQLite engine is preferred.
 */
export const makeSynchrotronSqliteWasmClientLayer = (
	config: Partial<SynchrotronClientConfigData> = {},
	options?: {
		readonly keyValueStoreLayer?: Layer.Layer<KeyValueStore.KeyValueStore>
	}
) => {
	const configLayer = createSynchrotronConfig(config)
	const keyValueStoreLayer = options?.keyValueStoreLayer ?? BrowserKeyValueStore.layerLocalStorage

	return SyncService.Default.pipe(
		Layer.provideMerge(SyncNetworkServiceLive),
		Layer.provideMerge(ActionRegistry.Default),
		Layer.provideMerge(ClockService.Default),
		Layer.provideMerge(ActionRecordRepo.Default),
		Layer.provideMerge(ActionModifiedRowRepo.Default),
		Layer.provideMerge(keyValueStoreLayer),
		Layer.provideMerge(SqliteClientDbAdapter),
		Layer.provideMerge(SqliteWasmClientMemoryLive),
		Layer.provideMerge(
			Layer.effectDiscard(
				Effect.gen(function* () {
					const cfg = yield* SynchrotronClientConfig
					yield* Effect.logInfo("synchrotron.client.start", {
						platform: "browser-sqlite-wasm",
						userId: cfg.userId ?? null,
						syncRpcUrl: cfg.syncRpcUrl,
						electricSyncUrl: cfg.electricSyncUrl
					})
				})
			)
		),
		Layer.provideMerge(configLayer),
		Layer.tap((context) => logInitialSyncDbState.pipe(Effect.provide(context)))
	)
}

/**
 * Default Synchrotron client layer with standard configuration
 */
export const SynchrotronClientLive = makeSynchrotronClientLayer()
