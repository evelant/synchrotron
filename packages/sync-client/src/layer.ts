import { BrowserKeyValueStore } from "@effect/platform-browser"
import {
	ActionModifiedRowRepo,
	ActionRecordRepo,
	ActionRegistry,
	ClockService,
	SyncService
} from "@synchrotron/sync-core"
import {
	SynchrotronClientConfig,
	SynchrotronClientConfigData,
	createSynchrotronConfig
} from "@synchrotron/sync-core/config"
import { initializeDatabaseSchema } from "@synchrotron/sync-core/db"
import { Effect, Layer } from "effect"
import { PgLiteClientLive } from "./db/connection"
import { ElectricSyncService } from "./electric/ElectricSyncService"
import { SyncNetworkServiceLive } from "./SyncNetworkService"

/**
 * Layer that automatically starts Electric sync after schema initialization
 */
export const ElectricSyncLive = Layer.scopedDiscard(
	Effect.gen(function* () {
		yield* Effect.logInfo(`Starting electric sync setup`)
		const service = yield* ElectricSyncService
		const config = yield* SynchrotronClientConfig

		yield* initializeDatabaseSchema
		yield* Effect.logInfo("Database schema initialized, starting Electric sync")

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
		Layer.provideMerge(SyncService.Default),
		Layer.provideMerge(SyncNetworkServiceLive),
		Layer.provideMerge(ActionRegistry.Default),
		Layer.provideMerge(ActionRecordRepo.Default),
		Layer.provideMerge(ActionModifiedRowRepo.Default),
		Layer.provideMerge(ClockService.Default),

		Layer.provideMerge(BrowserKeyValueStore.layerLocalStorage),

		Layer.provideMerge(PgLiteClientLive),

		Layer.provideMerge(configLayer)
	)
}

/**
 * Default Synchrotron client layer with standard configuration
 */
export const SynchrotronClientLive = makeSynchrotronClientLayer()
