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
import { RpcClient, RpcMiddleware, RpcSerialization } from "@effect/rpc"
import { SqlClient } from "@effect/sql"
import { SyncNetworkRpcGroup, SyncRpcAuthMiddleware } from "@synchrotron/sync-core/SyncNetworkRpc"
import { SyncNetworkService } from "@synchrotron/sync-core/SyncNetworkService"
import { ClientClockState, ClientIdentity } from "@synchrotron/sync-core"
import { Effect, Layer, Option, Redacted } from "effect"
import { SynchrotronClientConfig } from "./config"
import { SyncRpcAuthToken } from "./SyncRpcAuthToken"
import {
	makeFetchBootstrapSnapshot,
	makeFetchRemoteActions,
	type RemoteFetchMode
} from "./SyncNetworkServiceFetch"
import { makeSendLocalActions } from "./SyncNetworkServiceSend"

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

const makeSyncNetworkServiceLayer = (fetchMode: RemoteFetchMode) =>
	Layer.scoped(
		SyncNetworkService,
		Effect.gen(function* () {
			const identity = yield* ClientIdentity
			const clientId = yield* identity.get
			const clockState = yield* ClientClockState
			// Get the RPC client instance using the schema
			const client = yield* RpcClient.make(SyncNetworkRpcGroup)
			const sql = yield* SqlClient.SqlClient

			const sendLocalActions = makeSendLocalActions({ clientId, client })
			const fetchRemoteActions = makeFetchRemoteActions({
				clientId,
				client,
				sql,
				clockState,
				fetchMode
			})
			const fetchBootstrapSnapshot = makeFetchBootstrapSnapshot({ clientId, client })

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
