import type { KeyValueStore } from "@effect/platform"
import { BrowserKeyValueStore } from "@effect/platform-browser"
import type { SqlClient } from "@effect/sql/SqlClient"
import type { PgliteClient } from "@effect/sql-pglite/PgliteClient"
import {
	ActionModifiedRowRepo,
	ActionRecordRepo,
	ActionRegistry,
	type ClientDbAdapter,
	ClientClockState,
	DeterministicIdIdentityConfig,
	type ClientIdentity,
	type DeterministicIdIdentityStrategy,
	PostgresClientDbAdapter,
	SqliteClientDbAdapter,
	type SyncNetworkService,
	runSyncIngressRunner,
	SyncService
} from "@synchrotron/sync-core"
import { Effect, Layer } from "effect"
import type { SynchrotronClientConfigData } from "./config"
import { SynchrotronClientConfig, createSynchrotronConfig } from "./config"
import { PgliteClientLive } from "./db/connection"
import { SqliteWasmClientMemoryLive } from "./db/sqlite-wasm"
import { ClientIdentityLive } from "./ClientIdentity"
import { SyncNetworkServiceLive } from "./SyncNetworkService"
import { SyncRpcAuthTokenFromConfig } from "./SyncRpcAuthToken"
import type { SyncRpcAuthToken } from "./SyncRpcAuthToken"
import { logInitialSyncDbState } from "./logInitialDbState"
import type { SynchrotronTransport } from "./transports/Transport"

/**
 * Creates a fully configured Synchrotron client layer with custom configuration
 *
 * @example
 * ```ts
 * const clientLayer = makeSynchrotronClientLayer({
 *   rowIdentityByTable: {
 *     // Prefer stable identity columns for shared rows:
 *     notes: ["audience_key", "note_key"]
 *   },
 *   config: {
 *     syncRpcUrl: "https://my-sync-server.com/rpc",
 *     pglite: { dataDir: "idb://my-custom-db" }
 *   }
 * })
 * ```
 */
export type RowIdentityByTable = Readonly<Record<string, DeterministicIdIdentityStrategy>>

export type SynchrotronClientLayerServices =
	| SyncService
	| ActionRecordRepo
	| SqlClient
	| ActionModifiedRowRepo
	| ActionRegistry
	| DeterministicIdIdentityConfig
	| SynchrotronClientConfig
	| ClientIdentity
	| ClientClockState
	| SyncNetworkService
	| ClientDbAdapter
	| SyncRpcAuthToken
	| KeyValueStore.KeyValueStore
	| PgliteClient

export type MakeSynchrotronClientLayerParams = Readonly<{
	readonly rowIdentityByTable: RowIdentityByTable
	readonly transport?: SynchrotronTransport | undefined
	readonly config?: Partial<SynchrotronClientConfigData> | undefined
	readonly keyValueStoreLayer?: Layer.Layer<KeyValueStore.KeyValueStore> | undefined
}>

export function makeSynchrotronClientLayer(
	params: Omit<MakeSynchrotronClientLayerParams, "transport"> & {
		readonly transport?: undefined
	}
): Layer.Layer<SynchrotronClientLayerServices, unknown, never>
export function makeSynchrotronClientLayer<RNetwork, ENetwork, RIngress, EIngress>(
	params: Omit<MakeSynchrotronClientLayerParams, "transport"> & {
		readonly transport?: SynchrotronTransport<RNetwork, ENetwork, RIngress, EIngress> | undefined
	}
): Layer.Layer<
	SynchrotronClientLayerServices,
	unknown,
	Exclude<RNetwork | RIngress, SynchrotronClientLayerServices>
>
export function makeSynchrotronClientLayer(
	params: MakeSynchrotronClientLayerParams
): Layer.Layer<SynchrotronClientLayerServices, unknown, unknown> {
	// Create the config layer with custom config merged with defaults
	const transport = params.transport
	const configLayer = createSynchrotronConfig(params.config ?? {})
	const keyValueStoreLayer = params.keyValueStoreLayer ?? BrowserKeyValueStore.layerLocalStorage
	const syncNetworkServiceLayer = transport?.syncNetworkServiceLayer ?? SyncNetworkServiceLive
	const deterministicIdIdentityLayer = Layer.succeed(DeterministicIdIdentityConfig, {
		identityByTable: params.rowIdentityByTable
	})

	const baseLayer = SyncService.Default.pipe(
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
		Layer.provideMerge(deterministicIdIdentityLayer),
		Layer.tap((context) => logInitialSyncDbState.pipe(Effect.provide(context)))
	)

	// If the transport provides push/notify ingress, enable the core-owned ingress runner automatically.
	// Consumers should not need to compose `SyncIngress` + `runSyncIngressRunner` manually.
	if (!transport?.syncIngressLayer) return baseLayer

	return withSyncIngressRunner(transport.syncIngressLayer.pipe(Layer.provideMerge(baseLayer)))
}

/**
 * SQLite (WASM) client layer (no Electric integration).
 *
 * Intended for environments where PGlite is unavailable (or undesirable) and a stable SQLite engine is preferred.
 */
export const makeSynchrotronSqliteWasmClientLayer = (params: MakeSynchrotronClientLayerParams) => {
	const transport = params.transport
	const configLayer = createSynchrotronConfig(params.config ?? {})
	const keyValueStoreLayer = params.keyValueStoreLayer ?? BrowserKeyValueStore.layerLocalStorage
	const syncNetworkServiceLayer = transport?.syncNetworkServiceLayer ?? SyncNetworkServiceLive
	const deterministicIdIdentityLayer = Layer.succeed(DeterministicIdIdentityConfig, {
		identityByTable: params.rowIdentityByTable
	})

	const baseLayer = SyncService.Default.pipe(
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
		Layer.provideMerge(deterministicIdIdentityLayer),
		Layer.tap((context) => logInitialSyncDbState.pipe(Effect.provide(context)))
	)

	if (!transport?.syncIngressLayer) return baseLayer
	return withSyncIngressRunner(transport.syncIngressLayer.pipe(Layer.provideMerge(baseLayer)))
}

/**
 * Enables the core-owned `SyncIngress` runner for a given client layer.
 *
 * Most apps should prefer passing `transport` (with `syncIngressLayer`) to `makeSynchrotronClientLayer(...)`,
 * which enables the runner automatically.
 *
 * This helper is primarily for advanced composition/testing:
 * - provide `SyncIngress` (e.g. from Electric, WS, SSE, etc)
 * - wrap any layer that already provides `SqlClient` + `ClientDbAdapter` + `SyncService`
 *
 * The runner:
 * - ensures the sync schema exists (`clientDbAdapter.initializeSyncSchema`)
 * - ingests remote action-log batches into local sync tables
 * - triggers `SyncService.requestSync()` (single-flight + burst coalescing)
 */
export const withSyncIngressRunner = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
	layer.pipe(Layer.tap((context) => runSyncIngressRunner.pipe(Effect.provide(context))))
