import { SqlClient } from "@effect/sql"
import type { HLC } from "@synchrotron/sync-core/HLC"
import { Data, Effect, Schema } from "effect"
import { type ActionModifiedRow, type ActionRecord } from "./models" // Import ActionModifiedRow
import type { BadArgument } from "@effect/platform/Error"
import { ClientClockState } from "./ClientClockState"

export class RemoteActionFetchError extends Schema.TaggedError<RemoteActionFetchError>()(
	"RemoteActionFetchError",
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown)
	}
) {}

/**
 * The server cannot provide an incremental action log delta because the client's cursor is older
 * than the server's retained history window (e.g. action log compaction / retention deletion).
 *
 * Clients should recover via:
 * - `hardResync()` if they have no pending local actions
 * - `rebase()` if they do have pending local actions
 */
export class FetchRemoteActionsCompacted extends Schema.TaggedError<FetchRemoteActionsCompacted>()(
	"FetchRemoteActionsCompacted",
	{
		message: Schema.String,
		sinceServerIngestId: Schema.Number,
		minRetainedServerIngestId: Schema.Number,
		serverEpoch: Schema.String
	}
) {}

/**
 * The client has a different view of the server's sync history generation than the server.
 *
 * This indicates a discontinuity like a DB restore/reset, or a breaking migration that invalidates
 * the action log semantics. Clients should hard resync (no pending) or rebase (pending).
 */
export class SyncHistoryEpochMismatch extends Schema.TaggedError<SyncHistoryEpochMismatch>()(
	"SyncHistoryEpochMismatch",
	{
		message: Schema.String,
		localEpoch: Schema.NullOr(Schema.String),
		serverEpoch: Schema.String
	}
) {}

export class NetworkRequestError extends Schema.TaggedError<NetworkRequestError>()(
	"NetworkRequestError",
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown)
	}
) {}

/**
 * Typed failure reasons for `SendLocalActions`.
 *
 * These errors are intended to be thrown by the server and transported to clients via Effect RPC.
 */
export class SendLocalActionsBehindHead extends Schema.TaggedError<SendLocalActionsBehindHead>()(
	"SendLocalActionsBehindHead",
	{
		message: Schema.String,
		basisServerIngestId: Schema.Number,
		firstUnseenServerIngestId: Schema.Number,
		firstUnseenActionId: Schema.optional(Schema.String)
	}
) {}

export class SendLocalActionsDenied extends Schema.TaggedError<SendLocalActionsDenied>()(
	"SendLocalActionsDenied",
	{
		message: Schema.String,
		code: Schema.optional(Schema.String)
	}
) {}

export class SendLocalActionsInvalid extends Schema.TaggedError<SendLocalActionsInvalid>()(
	"SendLocalActionsInvalid",
	{
		message: Schema.String,
		code: Schema.optional(Schema.String)
	}
) {}

export class SendLocalActionsInternal extends Schema.TaggedError<SendLocalActionsInternal>()(
	"SendLocalActionsInternal",
	{
		message: Schema.String
	}
) {}

export type SendLocalActionsFailure =
	| SendLocalActionsBehindHead
	| SendLocalActionsDenied
	| SendLocalActionsInvalid
	| SendLocalActionsInternal

export const SendLocalActionsFailureSchema = Schema.Union(
	SendLocalActionsBehindHead,
	SendLocalActionsDenied,
	SendLocalActionsInvalid,
	SendLocalActionsInternal
)

export type FetchRemoteActionsFailure = RemoteActionFetchError | FetchRemoteActionsCompacted

export const FetchRemoteActionsFailureSchema = Schema.Union(
	RemoteActionFetchError,
	FetchRemoteActionsCompacted
)

export interface FetchResult {
	readonly serverEpoch: string
	readonly minRetainedServerIngestId: number
	actions: readonly ActionRecord[]
	modifiedRows: readonly ActionModifiedRow[]
}

export interface BootstrapSnapshot {
	readonly serverEpoch: string
	readonly minRetainedServerIngestId: number
	readonly serverIngestId: number
	readonly serverClock: HLC
	readonly tables: ReadonlyArray<{
		readonly tableName: string
		readonly rows: ReadonlyArray<Record<string, unknown>>
	}>
}

export interface TestNetworkState {
	/** Simulated network delay in milliseconds */
	networkDelay: number
	/** Whether network operations should fail */
	shouldFail: boolean
}

export class SyncNetworkService extends Effect.Service<SyncNetworkService>()("SyncNetworkService", {
	/**
	 * Live implementation using actual network requests
	 */
	effect: Effect.gen(function* () {
		yield* SqlClient.SqlClient
		const clockState = yield* ClientClockState
		const clientId = yield* clockState.getClientId

		return {
			fetchBootstrapSnapshot: (): Effect.Effect<
				BootstrapSnapshot,
				RemoteActionFetchError | BadArgument
			> =>
				Effect.fail(
					new RemoteActionFetchError({
						message: "Bootstrap snapshot is not implemented for this transport"
					})
				),
			fetchRemoteActions: (): Effect.Effect<FetchResult, FetchRemoteActionsFailure | BadArgument> =>
				Effect.gen(function* () {
					const sinceServerIngestId = yield* clockState.getLastSeenServerIngestId
					// TODO: Implement actual network request to fetch remote actions
					// This would use fetch or another HTTP client to contact the sync server
					yield* Effect.logInfo(
						`Fetching remote actions since server_ingest_id=${sinceServerIngestId} for client ${clientId}`
					)

					// For now return empty array as placeholder
					// Need to return both actions and modifiedRows
					return {
						serverEpoch: "unknown",
						minRetainedServerIngestId: 0,
						actions: [],
						modifiedRows: []
					} satisfies FetchResult
				}).pipe(
					Effect.catchAll((error) =>
						Effect.fail(
							new RemoteActionFetchError({
								message: "Failed to fetch remote actions",
								cause: error
							})
						)
					)
				),

			sendLocalActions: (
				actions: readonly ActionRecord[],
				amrs: readonly ActionModifiedRow[],
				basisServerIngestId: number
			): Effect.Effect<
				boolean,
				SendLocalActionsFailure | NetworkRequestError | BadArgument,
				never
			> =>
				Effect.gen(function* () {
					// TODO: Implement actual network request to send actions to remote server
					yield* Effect.logInfo(`Sending ${actions.length} local actions to server`)
					yield* Effect.logDebug(`basisServerIngestId=${basisServerIngestId}`)

					// For now just return true as placeholder
					return true
				}).pipe(
					Effect.catchAll((error) =>
						Effect.fail(
							new NetworkRequestError({
								message: "Failed to send local actions",
								cause: error
							})
						)
					)
				)
		}
	})
}) {}
