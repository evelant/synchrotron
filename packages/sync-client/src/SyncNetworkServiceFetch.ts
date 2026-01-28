/**
 * RPC implementation details for `SyncNetworkService.fetchRemoteActions` and `.fetchBootstrapSnapshot`.
 *
 * These methods are transport-only:
 * - `fetchRemoteActions` returns the server's action-log rows (or metadata-only in Electric mode).
 * - `fetchBootstrapSnapshot` returns a snapshot for initial client bootstrapping.
 *
 * Ingestion and local apply/reconcile logic is owned by `sync-core`.
 */
import type { RpcClientError } from "@effect/rpc"
import type { BadArgument } from "@effect/platform/Error"
import type { SqlClient, SqlError } from "@effect/sql"
import type { ParseError } from "effect/ParseResult"
import type {
	BootstrapSnapshot,
	FetchRemoteActionsCompacted,
	FetchResult
} from "@synchrotron/sync-core/SyncNetworkService"
import { RemoteActionFetchError } from "@synchrotron/sync-core/SyncNetworkService"
import type { SyncNetworkService } from "@synchrotron/sync-core/SyncNetworkService"
import type { ClientClockState, ClientClockStateError } from "@synchrotron/sync-core"
import { HLC } from "@synchrotron/sync-core/HLC"
import { Effect } from "effect"

type SyncNetworkRpcClient = Readonly<{
	FetchRemoteActions: (payload: {
		readonly clientId: string
		readonly sinceServerIngestId: number
		readonly includeSelf?: boolean
	}) => Effect.Effect<
		FetchResult,
		| BadArgument
		| FetchRemoteActionsCompacted
		| RemoteActionFetchError
		| RpcClientError.RpcClientError,
		never
	>
	FetchBootstrapSnapshot: (payload: {
		readonly clientId: string
	}) => Effect.Effect<
		BootstrapSnapshot,
		BadArgument | RemoteActionFetchError | RpcClientError.RpcClientError,
		never
	>
}>

export type RemoteFetchMode = "full" | "metaOnly"

type RemoteFetchTaggedError =
	| BadArgument
	| FetchRemoteActionsCompacted
	| RemoteActionFetchError
	| RpcClientError.RpcClientError
	| SqlError.SqlError
	| ParseError
	| ClientClockStateError

type BootstrapSnapshotTaggedError =
	| BadArgument
	| RemoteActionFetchError
	| RpcClientError.RpcClientError
	| ParseError

const errorMessage = (error: { readonly _tag: string } & Partial<{ readonly message: string }>) =>
	typeof error.message === "string" && error.message.length > 0 ? error.message : error._tag

const mapRemoteFetchErrors = <A>(effect: Effect.Effect<A, RemoteFetchTaggedError, never>) =>
	effect.pipe(
		Effect.catchAll((error) => {
			switch (error._tag) {
				case "BadArgument":
				case "FetchRemoteActionsCompacted":
				case "RemoteActionFetchError": {
					return Effect.fail(error)
				}
				case "RpcClientError": {
					return Effect.fail(
						new RemoteActionFetchError({
							message: error.message,
							cause: error.cause ?? error
						})
					)
				}
				default: {
					return Effect.fail(
						new RemoteActionFetchError({
							message: errorMessage(error),
							cause: error
						})
					)
				}
			}
		})
	)

const mapBootstrapSnapshotErrors = <A>(
	effect: Effect.Effect<A, BootstrapSnapshotTaggedError, never>
) =>
	effect.pipe(
		Effect.catchAll((error) => {
			switch (error._tag) {
				case "BadArgument":
				case "RemoteActionFetchError": {
					return Effect.fail(error)
				}
				case "RpcClientError": {
					return Effect.fail(
						new RemoteActionFetchError({
							message: error.message,
							cause: error.cause ?? error
						})
					)
				}
				default: {
					return Effect.fail(
						new RemoteActionFetchError({
							message: errorMessage(error),
							cause: error
						})
					)
				}
			}
		})
	)

const getIncludeSelfForBootstrap = (deps: {
	readonly sql: SqlClient.SqlClient
	readonly sinceServerIngestId: number
}) =>
	Effect.gen(function* () {
		const { sql, sinceServerIngestId } = deps
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
		return { includeSelf, effectiveSinceServerIngestId } as const
	})

export const makeFetchRemoteActions = (deps: {
	readonly clientId: string
	readonly client: SyncNetworkRpcClient
	readonly sql: SqlClient.SqlClient
	readonly clockState: ClientClockState
	readonly fetchMode: RemoteFetchMode
}): SyncNetworkService["fetchRemoteActions"] => {
	const { clientId, client, sql, clockState, fetchMode } = deps

	if (fetchMode === "metaOnly") {
		return () =>
			Effect.gen(function* () {
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
			}).pipe(mapRemoteFetchErrors)
	}

	return () =>
		Effect.gen(function* () {
			yield* Effect.logInfo("sync.network.fetchRemoteActions.start", { clientId })
			const sinceServerIngestId = yield* clockState.getLastSeenServerIngestId

			const { includeSelf, effectiveSinceServerIngestId } = yield* getIncludeSelfForBootstrap({
				sql,
				sinceServerIngestId
			})

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
		}).pipe(mapRemoteFetchErrors)
}

export const makeFetchBootstrapSnapshot = (deps: {
	readonly clientId: string
	readonly client: SyncNetworkRpcClient
}): SyncNetworkService["fetchBootstrapSnapshot"] => {
	const { clientId, client } = deps

	return () =>
		mapBootstrapSnapshotErrors(
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
			})
		)
}
