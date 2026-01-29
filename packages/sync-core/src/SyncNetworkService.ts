import type { HLC } from "./HLC"
import type { ActionModifiedRow, ActionRecord } from "./models"
import { Effect, Schema } from "effect"

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

export interface SyncNetworkServiceService {
	readonly fetchBootstrapSnapshot: () => Effect.Effect<BootstrapSnapshot, RemoteActionFetchError>
	readonly fetchRemoteActions: () => Effect.Effect<FetchResult, FetchRemoteActionsFailure>
	readonly sendLocalActions: (
		actions: readonly ActionRecord[],
		amrs: readonly ActionModifiedRow[],
		basisServerIngestId: number
	) => Effect.Effect<boolean, SendLocalActionsFailure | NetworkRequestError>
}

const MissingSyncNetworkServiceMessage =
	"No SyncNetworkService implementation installed (provide SyncNetworkServiceLive from @synchrotron/sync-client)"

const MissingSyncNetworkService: SyncNetworkServiceService = {
	fetchBootstrapSnapshot: () =>
		Effect.fail(new RemoteActionFetchError({ message: MissingSyncNetworkServiceMessage })),
	fetchRemoteActions: () =>
		Effect.fail(new RemoteActionFetchError({ message: MissingSyncNetworkServiceMessage })),
	sendLocalActions: (
		_actions: readonly ActionRecord[],
		_amrs: readonly ActionModifiedRow[],
		_basisServerIngestId: number
	) => Effect.fail(new NetworkRequestError({ message: MissingSyncNetworkServiceMessage }))
}

/**
 * SyncNetworkService is a transport abstraction.
 *
 * `sync-core` defines the contract, but does not provide a live implementation.
 * Client runtimes (e.g. `@synchrotron/sync-client`) provide concrete layers (RPC, Electric ingress, tests).
 */
export class SyncNetworkService extends Effect.Service<SyncNetworkService>()("SyncNetworkService", {
	effect: Effect.succeed(MissingSyncNetworkService)
}) {}
