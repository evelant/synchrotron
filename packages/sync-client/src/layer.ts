import type { KeyValueStore } from "@effect/platform"
import { BrowserKeyValueStore } from "@effect/platform-browser"
import {
	ActionModifiedRowRepo,
	ActionRecordRepo,
	ActionRegistry,
	ClientDbAdapter,
	ClientClockState,
	PostgresClientDbAdapter,
	SqliteClientDbAdapter,
	SyncService
} from "@synchrotron/sync-core"
import type { SynchrotronClientConfigData } from "@synchrotron/sync-core/config"
import { SynchrotronClientConfig, createSynchrotronConfig } from "@synchrotron/sync-core/config"
import { Effect, Layer } from "effect"
import { PgliteClientLive } from "./db/connection"
import { SqliteWasmClientMemoryLive } from "./db/sqlite-wasm"
import { ClientIdentityLive } from "./ClientIdentity"
import { ElectricSyncService } from "./electric/ElectricSyncService"
import { SyncNetworkServiceElectricLive, SyncNetworkServiceLive } from "./SyncNetworkService"
import { SyncRpcAuthTokenFromConfig } from "./SyncRpcAuthToken"
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
		readonly syncNetworkServiceLayer?: typeof SyncNetworkServiceLive
	}
) => {
	// Create the config layer with custom config merged with defaults
	const configLayer = createSynchrotronConfig(config)
	const keyValueStoreLayer = options?.keyValueStoreLayer ?? BrowserKeyValueStore.layerLocalStorage
	const syncNetworkServiceLayer = options?.syncNetworkServiceLayer ?? SyncNetworkServiceLive

	// Note: Electric is intentionally optional. Do not start Electric replication
	// unless the consumer explicitly adds `ElectricSyncLive` (preferred) to their app layer.
	// (If you wire `ElectricSyncService.Default` directly, ensure the sync schema is initialized first.)
	return SyncService.Default.pipe(
		// Highest-level services first, core dependencies last.
		// `Layer.provideMerge` wraps previously-added layers, so later layers are available to earlier ones.
		Layer.provideMerge(syncNetworkServiceLayer),
		Layer.provideMerge(SyncRpcAuthTokenFromConfig),
		Layer.provideMerge(ActionRegistry.Default),
		Layer.provideMerge(ClientClockState.Default),
		Layer.provideMerge(ActionRecordRepo.Default),
		Layer.provideMerge(ActionModifiedRowRepo.Default),
		Layer.provideMerge(ClientIdentityLive),
		Layer.provideMerge(keyValueStoreLayer),
		Layer.provideMerge(PostgresClientDbAdapter),
		Layer.provideMerge(PgliteClientLive),
		Layer.provideMerge(
			Layer.effectDiscard(
				Effect.gen(function* () {
					const cfg = yield* SynchrotronClientConfig
					yield* Effect.logInfo("synchrotron.client.start", {
						platform: "browser-pglite",
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
		readonly syncNetworkServiceLayer?: typeof SyncNetworkServiceLive
	}
) => {
	const configLayer = createSynchrotronConfig(config)
	const keyValueStoreLayer = options?.keyValueStoreLayer ?? BrowserKeyValueStore.layerLocalStorage
	const syncNetworkServiceLayer = options?.syncNetworkServiceLayer ?? SyncNetworkServiceLive

	return SyncService.Default.pipe(
		Layer.provideMerge(syncNetworkServiceLayer),
		Layer.provideMerge(SyncRpcAuthTokenFromConfig),
		Layer.provideMerge(ActionRegistry.Default),
		Layer.provideMerge(ClientClockState.Default),
		Layer.provideMerge(ActionRecordRepo.Default),
		Layer.provideMerge(ActionModifiedRowRepo.Default),
		Layer.provideMerge(ClientIdentityLive),
		Layer.provideMerge(keyValueStoreLayer),
		Layer.provideMerge(SqliteClientDbAdapter),
		Layer.provideMerge(SqliteWasmClientMemoryLive),
		Layer.provideMerge(
			Layer.effectDiscard(
				Effect.gen(function* () {
					const cfg = yield* SynchrotronClientConfig
					yield* Effect.logInfo("synchrotron.client.start", {
						platform: "browser-sqlite-wasm",
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

/**
 * PGlite client with Electric ingress enabled.
 *
 * This wires:
 * - Electric shape replication for remote ingress (`ElectricSyncLive`)
 * - RPC for uploads + server metadata (`SyncNetworkServiceElectricLive`)
 *
 * The key property is that RPC fetch does **not** ingest remote actions when Electric is enabled,
 * avoiding the “two ingress writers” pitfall. Remote apply remains DB-driven via `SyncService.performSync()`.
 */
export const makeSynchrotronElectricClientLayer = (
	config: Partial<SynchrotronClientConfigData> = {},
	options?: {
		readonly keyValueStoreLayer?: Layer.Layer<KeyValueStore.KeyValueStore>
	}
) =>
	ElectricSyncLive.pipe(
		Layer.provideMerge(
			makeSynchrotronClientLayer(config, {
				...options,
				syncNetworkServiceLayer: SyncNetworkServiceElectricLive
			})
		)
	)
