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
	SynchrotronClientConfigData,
	createSynchrotronConfig
} from "@synchrotron/sync-core/config"
import { Effect, Layer } from "effect"
import { PgLiteClientLive } from "./db/connection"
import { SqliteWasmClientMemoryLive } from "./db/sqlite-wasm"
import { makeSqliteReactNativeClientLayer } from "./db/sqlite-react-native"
import { ElectricSyncService } from "./electric/ElectricSyncService"
import { SyncNetworkServiceLive } from "./SyncNetworkService"

/**
 * Layer that automatically starts Electric sync after schema initialization
 */
export const ElectricSyncLive = Layer.scopedDiscard(
	Effect.gen(function* () {
		yield* Effect.logInfo(`Starting electric sync setup`)
		const clientDbAdapter = yield* ClientDbAdapter

		yield* clientDbAdapter.initializeSyncSchema
		yield* Effect.logInfo("Database schema initialized, starting Electric sync")

		// Electric sync may attempt to write into `action_records` / `action_modified_rows`,
		// so ensure schema exists before acquiring the service.
		const service = yield* ElectricSyncService

		return service
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
export const makeSynchrotronClientLayer = (config: Partial<SynchrotronClientConfigData> = {}) => {
	// Create the config layer with custom config merged with defaults
	const configLayer = createSynchrotronConfig(config)

	return ElectricSyncService.Default.pipe(
		// Highest-level services first, core dependencies last.
		// `Layer.provideMerge` wraps previously-added layers, so later layers are available to earlier ones.
		Layer.provideMerge(SyncService.Default),
		Layer.provideMerge(SyncNetworkServiceLive),
		Layer.provideMerge(ActionRegistry.Default),
		Layer.provideMerge(ClockService.Default),
		Layer.provideMerge(ActionRecordRepo.Default),
		Layer.provideMerge(ActionModifiedRowRepo.Default),
		Layer.provideMerge(BrowserKeyValueStore.layerLocalStorage),
		Layer.provideMerge(PostgresClientDbAdapter),
		Layer.provideMerge(PgLiteClientLive),
		Layer.provideMerge(configLayer)
	)
}

/**
 * SQLite (WASM) client layer (no Electric integration).
 *
 * Intended for environments where PGlite is unavailable (or undesirable) and a stable SQLite engine is preferred.
 */
export const makeSynchrotronSqliteWasmClientLayer = (
	config: Partial<SynchrotronClientConfigData> = {}
) => {
	const configLayer = createSynchrotronConfig(config)

	return SyncService.Default.pipe(
		Layer.provideMerge(SyncNetworkServiceLive),
		Layer.provideMerge(ActionRegistry.Default),
		Layer.provideMerge(ClockService.Default),
		Layer.provideMerge(ActionRecordRepo.Default),
		Layer.provideMerge(ActionModifiedRowRepo.Default),
		Layer.provideMerge(BrowserKeyValueStore.layerLocalStorage),
		Layer.provideMerge(SqliteClientDbAdapter),
		Layer.provideMerge(SqliteWasmClientMemoryLive),
		Layer.provideMerge(configLayer)
	)
}

/**
 * SQLite (React Native) client layer (no Electric integration).
 *
 * The caller supplies the database config for `@effect/sql-sqlite-react-native`.
 */
export const makeSynchrotronSqliteReactNativeClientLayer = (
	sqliteConfig: Parameters<typeof makeSqliteReactNativeClientLayer>[0],
	config: Partial<SynchrotronClientConfigData> = {}
) => {
	const configLayer = createSynchrotronConfig(config)

	return SyncService.Default.pipe(
		Layer.provideMerge(SyncNetworkServiceLive),
		Layer.provideMerge(ActionRegistry.Default),
		Layer.provideMerge(ClockService.Default),
		Layer.provideMerge(ActionRecordRepo.Default),
		Layer.provideMerge(ActionModifiedRowRepo.Default),
		// TODO: replace with a persistent RN key-value store layer (AsyncStorage, etc)
		Layer.provideMerge(KeyValueStore.layerMemory),
		Layer.provideMerge(SqliteClientDbAdapter),
		Layer.provideMerge(makeSqliteReactNativeClientLayer(sqliteConfig)),
		Layer.provideMerge(configLayer)
	)
}

/**
 * Default Synchrotron client layer with standard configuration
 */
export const SynchrotronClientLive = makeSynchrotronClientLayer()
