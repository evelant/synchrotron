import { KeyValueStore } from "@effect/platform"
import {
	ActionModifiedRowRepo,
	ActionRecordRepo,
	ActionRegistry,
	ClockService,
	SqliteClientDbAdapter,
	SyncService
} from "@synchrotron/sync-core"
import { SynchrotronClientConfigData, createSynchrotronConfig } from "@synchrotron/sync-core/config"
import { Layer } from "effect"
import { makeSqliteReactNativeClientLayer } from "./db/sqlite-react-native"
import { SyncNetworkServiceLive } from "./SyncNetworkService"

/**
 * SQLite (React Native) client layer (no Electric integration).
 *
 * The caller supplies the database config for the underlying `@op-engineering/op-sqlite` database.
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
		Layer.provideMerge(KeyValueStore.layerMemory),
		Layer.provideMerge(SqliteClientDbAdapter),
		Layer.provideMerge(makeSqliteReactNativeClientLayer(sqliteConfig)),
		Layer.provideMerge(configLayer)
	)
}

export { makeSqliteReactNativeClientLayer } from "./db/sqlite-react-native"
