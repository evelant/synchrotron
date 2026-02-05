import {
	ActionModifiedRowRepo,
	ActionRecordRepo,
	ActionRegistry,
	ClientClockState,
	DeterministicIdIdentityConfig,
	type DeterministicIdIdentityStrategy,
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
	params: Readonly<{
		readonly sqliteConfig: Parameters<typeof makeSqliteReactNativeClientLayer>[0]
		readonly rowIdentityByTable: Readonly<Record<string, DeterministicIdIdentityStrategy>>
		readonly config?: Partial<SynchrotronClientConfigData> | undefined
	}>
) => {
	const configLayer = createSynchrotronConfig(params.config ?? {})
	const deterministicIdIdentityLayer = Layer.succeed(DeterministicIdIdentityConfig, {
		identityByTable: params.rowIdentityByTable
	})

	return SyncService.Default.pipe(
		Layer.provideMerge(
			Layer.effectDiscard(
				Effect.logInfo("synchrotron.client.start", {
					platform: "react-native",
					hasSyncRpcAuthToken:
						typeof params.config?.syncRpcAuthToken === "string" &&
						params.config.syncRpcAuthToken.length > 0,
					sqliteFilename: params.sqliteConfig.filename,
					syncRpcUrl: params.config?.syncRpcUrl ?? null,
					electricSyncUrl: params.config?.electricSyncUrl ?? null
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
		Layer.provideMerge(makeSqliteReactNativeClientLayer(params.sqliteConfig)),
		Layer.provideMerge(configLayer),
		Layer.provideMerge(deterministicIdIdentityLayer),
		Layer.tap((context) => logInitialSyncDbState.pipe(Effect.provide(context)))
	)
}

export { makeSqliteReactNativeClientLayer } from "./db/sqlite-react-native"
