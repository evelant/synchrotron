import {
	ActionModifiedRowRepo,
	ActionRecordRepo,
	ActionRegistry,
	ClientClockState,
	SqliteClientDbAdapter,
	SyncService
} from "@synchrotron/sync-core"
import { Effect, Layer } from "effect"
import type { SynchrotronClientConfigData } from "./config"
import { createSynchrotronConfig } from "./config"
import { makeSqliteReactNativeClientLayer } from "./db/sqlite-react-native"
import { logInitialSyncDbState } from "./logInitialDbState"
import { ClientIdentityLive } from "./ClientIdentity"
import { SyncRpcAuthTokenFromConfig } from "./SyncRpcAuthToken"
import { SynchrotronKeyValueStoreLive } from "./synchrotronKeyValueStore"
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
		Layer.provideMerge(
			Layer.effectDiscard(
				Effect.logInfo("synchrotron.client.start", {
					platform: "react-native",
					hasSyncRpcAuthToken:
						typeof config.syncRpcAuthToken === "string" && config.syncRpcAuthToken.length > 0,
					sqliteFilename: sqliteConfig.filename,
					syncRpcUrl: config.syncRpcUrl ?? null,
					electricSyncUrl: config.electricSyncUrl ?? null
				})
			)
		),
		Layer.provideMerge(SyncNetworkServiceLive),
		Layer.provideMerge(SyncRpcAuthTokenFromConfig),
		Layer.provideMerge(ActionRegistry.Default),
		Layer.provideMerge(ClientClockState.Default),
		Layer.provideMerge(ActionRecordRepo.Default),
		Layer.provideMerge(ActionModifiedRowRepo.Default),
		Layer.provideMerge(ClientIdentityLive),
		Layer.provideMerge(SynchrotronKeyValueStoreLive),
		Layer.provideMerge(SqliteClientDbAdapter),
		Layer.provideMerge(makeSqliteReactNativeClientLayer(sqliteConfig)),
		Layer.provideMerge(configLayer),
		Layer.tap((context) => logInitialSyncDbState.pipe(Effect.provide(context)))
	)
}

export { makeSqliteReactNativeClientLayer } from "./db/sqlite-react-native"
