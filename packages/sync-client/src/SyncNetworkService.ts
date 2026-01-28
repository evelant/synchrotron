/**
 * SyncNetworkService client implementations (RPC transport).
 *
 * This module implements the `SyncNetworkService` interface from `sync-core` using Effect RPC.
 *
 * Important contract: transports do NOT own ingestion.
 * - RPC fetch returns action-log rows (or metadata-only in Electric mode).
 * - `sync-core` owns ingesting those rows into `action_records` / `action_modified_rows`
 *   (see `ingestRemoteSyncLogBatch`) and all DB-driven apply/reconcile logic.
 *
 * Upload (`sendLocalActions`) is always RPC — we intentionally do not abstract the upload transport.
 */
import { FetchHttpClient } from "@effect/platform"
import * as Headers from "@effect/platform/Headers"
import type { RpcClientError } from "@effect/rpc"
import { RpcClient, RpcMiddleware, RpcSerialization } from "@effect/rpc"
import { SqlClient } from "@effect/sql"
import { SyncNetworkRpcGroup, SyncRpcAuthMiddleware } from "@synchrotron/sync-core/SyncNetworkRpc"
import type { FetchRemoteActionsCompacted } from "@synchrotron/sync-core/SyncNetworkService"
import {
	NetworkRequestError,
	RemoteActionFetchError,
	SyncNetworkService
} from "@synchrotron/sync-core/SyncNetworkService"
import { HLC } from "@synchrotron/sync-core/HLC"
import type { ActionRecord } from "@synchrotron/sync-core/models"
import type { ActionModifiedRow } from "@synchrotron/sync-core/models"
import { ClientClockState, ClientIdentity, CorrectionActionTag } from "@synchrotron/sync-core"
import { Cause, Chunk, Effect, Layer, Option, Redacted } from "effect"
import { SynchrotronClientConfig } from "./config"
import { SyncRpcAuthToken } from "./SyncRpcAuthToken"

const valuePreview = (value: unknown, maxLength = 500) => {
	const json = JSON.stringify(value)
	return json.length <= maxLength ? json : `${json.slice(0, maxLength)}…`
}

const AuthClientLive: Layer.Layer<
	RpcMiddleware.ForClient<SyncRpcAuthMiddleware>,
	never,
	SyncRpcAuthToken
> = RpcMiddleware.layerClient(SyncRpcAuthMiddleware, ({ request }) =>
	Effect.gen(function* () {
		const tokenService = yield* SyncRpcAuthToken
		const tokenOption = yield* tokenService.get
		if (Option.isNone(tokenOption)) return request

		return {
			...request,
			headers: Headers.set(
				request.headers,
				"authorization",
				`Bearer ${Redacted.value(tokenOption.value)}`
			)
		}
	})
)

const ProtocolLive = Layer.unwrapEffect(
	Effect.gen(function* () {
		const config = yield* SynchrotronClientConfig
		return RpcClient.layerProtocolHttp({ url: config.syncRpcUrl }).pipe(
			Layer.provide(FetchHttpClient.layer),
			Layer.provide(RpcSerialization.layerJson)
		)
	})
)

type RemoteFetchMode = "full" | "metaOnly"

const makeSyncNetworkServiceLayer = (fetchMode: RemoteFetchMode) =>
	Layer.scoped(
		SyncNetworkService,
		Effect.gen(function* (_) {
			const identity = yield* ClientIdentity
			const clientId = yield* identity.get
			const clockState = yield* ClientClockState
			// Get the RPC client instance using the schema
			const client = yield* RpcClient.make(SyncNetworkRpcGroup)
			const sql = yield* SqlClient.SqlClient

			const summarizeActions = (actions: ReadonlyArray<ActionRecord>) =>
				actions.map((a) => ({
					id: a.id,
					_tag: a._tag,
					client_id: a.client_id,
					server_ingest_id: a.server_ingest_id,
					transaction_id: a.transaction_id,
					clock: a.clock
				}))

			const summarizeAmrs = (amrs: ReadonlyArray<ActionModifiedRow>) => {
				const countsByActionRecordId: Record<string, number> = {}
				const countsByTable: Record<string, number> = {}
				for (const amr of amrs) {
					countsByActionRecordId[amr.action_record_id] =
						(countsByActionRecordId[amr.action_record_id] ?? 0) + 1
					countsByTable[amr.table_name] = (countsByTable[amr.table_name] ?? 0) + 1
				}
				return { countsByActionRecordId, countsByTable }
			}

			const sendLocalActions = (
				actions: ReadonlyArray<ActionRecord>,
				amrs: ReadonlyArray<ActionModifiedRow>,
				basisServerIngestId: number
			) =>
				Effect.gen(function* () {
					const amrSummary = summarizeAmrs(amrs)
					yield* Effect.logInfo("sync.network.sendLocalActions.start", {
						clientId,
						basisServerIngestId,
						actionCount: actions.length,
						amrCount: amrs.length,
						actionTags: actions.reduce<Record<string, number>>((acc, a) => {
							acc[a._tag] = (acc[a._tag] ?? 0) + 1
							return acc
						}, {}),
						amrCountsByTable: amrSummary.countsByTable
					})

					const correctionActionIds = new Set(
						actions.filter((a) => a._tag === CorrectionActionTag).map((a) => a.id)
					)
					if (correctionActionIds.size > 0) {
						const correctionAmrs = amrs
							.filter((amr) => correctionActionIds.has(amr.action_record_id))
							.slice(0, 10)
						yield* Effect.logDebug("sync.network.sendLocalActions.correctionDelta.preview", {
							clientId,
							correctionActionIds: Array.from(correctionActionIds),
							correctionAmrPreview: correctionAmrs.map((amr) => ({
								id: amr.id,
								table_name: amr.table_name,
								row_id: amr.row_id,
								operation: amr.operation,
								forward_patches: valuePreview(amr.forward_patches),
								reverse_patches: valuePreview(amr.reverse_patches)
							}))
						})
					}

					yield* Effect.logDebug("sync.network.sendLocalActions.payload", {
						clientId,
						actions: summarizeActions(actions),
						amrs: {
							countsByActionRecordId: amrSummary.countsByActionRecordId,
							countsByTable: amrSummary.countsByTable
						}
					})

					const result = yield* client.SendLocalActions({
						actions,
						amrs,
						clientId,
						basisServerIngestId
					})
					yield* Effect.logInfo("sync.network.sendLocalActions.success", {
						clientId,
						basisServerIngestId,
						actionCount: actions.length,
						amrCount: amrs.length
					})
					return result
				}).pipe(
					Effect.tapErrorCause((c) =>
						Effect.logError("sync.network.sendLocalActions.error", {
							clientId,
							cause: Cause.pretty(c),
							defects: Cause.defects(c).pipe(
								Chunk.map((d) => JSON.stringify(d, undefined, 2)),
								Chunk.toArray
							)
						})
					),
					Effect.catchTag("RpcClientError", (error: RpcClientError.RpcClientError) =>
						Effect.fail(
							new NetworkRequestError({
								message: error.message,
								cause: error.cause ?? error
							})
						)
					)
				)

			const fetchRemoteActions = () =>
				fetchMode === "metaOnly"
					? Effect.gen(function* () {
							yield* Effect.logInfo("sync.network.fetchRemoteActions.metaOnly.start", { clientId })
							const lastSeenServerIngestId = yield* clockState.getLastSeenServerIngestId
							const remote = yield* client.FetchRemoteActions({
								clientId,
								// Intentionally request a cursor beyond any plausible server head so the response
								// includes metadata but no action log rows. In Electric-enabled clients, the
								// authoritative ingress is the Electric stream, not this RPC fetch.
								sinceServerIngestId: Number.MAX_SAFE_INTEGER,
								includeSelf: false
							})
							yield* Effect.logInfo("sync.network.fetchRemoteActions.metaOnly.result", {
								clientId,
								lastSeenServerIngestId,
								serverEpoch: remote.serverEpoch,
								minRetainedServerIngestId: remote.minRetainedServerIngestId,
								actionCount: remote.actions.length,
								amrCount: remote.modifiedRows.length
							})
							return {
								serverEpoch: remote.serverEpoch,
								minRetainedServerIngestId: remote.minRetainedServerIngestId,
								actions: [] as const,
								modifiedRows: [] as const
							}
						}).pipe(
							Effect.catchTag("FetchRemoteActionsCompacted", (error: FetchRemoteActionsCompacted) =>
								Effect.fail(error)
							),
							Effect.catchTag("RpcClientError", (error: RpcClientError.RpcClientError) =>
								Effect.fail(
									new RemoteActionFetchError({
										message: error.message,
										cause: error.cause ?? error
									})
								)
							),
							Effect.catchAll((error) =>
								Effect.fail(
									new RemoteActionFetchError({
										message: error instanceof Error ? error.message : String(error),
										cause: error
									})
								)
							)
						)
					: Effect.gen(function* () {
							yield* Effect.logInfo("sync.network.fetchRemoteActions.start", { clientId })
							const sinceServerIngestId = yield* clockState.getLastSeenServerIngestId

							const [localState] = yield* sql<{
								readonly has_any_action_records: boolean | 0 | 1
							}>`
								SELECT EXISTS (SELECT 1 FROM action_records LIMIT 1) as has_any_action_records
							`
							const hasAnyActionRecords =
								typeof localState?.has_any_action_records === "boolean"
									? localState.has_any_action_records
									: localState?.has_any_action_records === 1

							const includeSelf = !hasAnyActionRecords && sinceServerIngestId === 0
							const effectiveSinceServerIngestId = includeSelf ? 0 : sinceServerIngestId

							yield* Effect.logInfo("sync.network.fetchRemoteActions.cursor", {
								clientId,
								sinceServerIngestId,
								effectiveSinceServerIngestId,
								includeSelf
							})

							const remote = yield* client.FetchRemoteActions({
								clientId,
								sinceServerIngestId: effectiveSinceServerIngestId,
								includeSelf
							})
							yield* Effect.logInfo("sync.network.fetchRemoteActions.result", {
								clientId,
								serverEpoch: remote.serverEpoch,
								minRetainedServerIngestId: remote.minRetainedServerIngestId,
								actionCount: remote.actions.length,
								amrCount: remote.modifiedRows.length,
								actionTags: remote.actions.reduce<Record<string, number>>((acc, a) => {
									acc[a._tag] = (acc[a._tag] ?? 0) + 1
									return acc
								}, {})
							})
							return remote
						}).pipe(
							Effect.catchTag("FetchRemoteActionsCompacted", (error: FetchRemoteActionsCompacted) =>
								Effect.fail(error)
							),
							Effect.catchTag("RpcClientError", (error: RpcClientError.RpcClientError) =>
								Effect.fail(
									new RemoteActionFetchError({
										message: error.message,
										cause: error.cause ?? error
									})
								)
							),
							Effect.catchAll((error) =>
								Effect.fail(
									new RemoteActionFetchError({
										message: error instanceof Error ? error.message : String(error),
										cause: error
									})
								)
							)
						)

			const fetchBootstrapSnapshot = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("sync.network.fetchBootstrapSnapshot.start", { clientId })
					const snapshot = yield* client.FetchBootstrapSnapshot({ clientId })
					yield* Effect.logInfo("sync.network.fetchBootstrapSnapshot.result", {
						clientId,
						serverEpoch: snapshot.serverEpoch,
						minRetainedServerIngestId: snapshot.minRetainedServerIngestId,
						serverIngestId: snapshot.serverIngestId,
						tableCount: snapshot.tables.length,
						rowCounts: snapshot.tables.map((t) => ({
							tableName: t.tableName,
							rowCount: t.rows.length
						}))
					})
					return { ...snapshot, serverClock: HLC.make(snapshot.serverClock) }
				}).pipe(
					Effect.mapError(
						(error) =>
							new RemoteActionFetchError({
								message: error instanceof Error ? error.message : String(error),
								cause: error
							})
					)
				)

			return SyncNetworkService.of({
				_tag: "SyncNetworkService",
				sendLocalActions,
				fetchBootstrapSnapshot,
				fetchRemoteActions
			})
		})
	).pipe(Layer.provide(AuthClientLive), Layer.provide(ProtocolLive)) // Provide the configured protocol + auth middleware layers

export const SyncNetworkServiceLive = makeSyncNetworkServiceLayer("full")

/**
 * RPC transport variant for Electric-ingress clients.
 *
 * - Uploads are still performed over RPC (`sendLocalActions`).
 * - Remote ingress is performed by Electric (shape replication), so `fetchRemoteActions` only fetches
 *   server metadata (epoch + retention watermark) and returns no action rows.
 */
export const SyncNetworkServiceElectricLive = makeSyncNetworkServiceLayer("metaOnly")
