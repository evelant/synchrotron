import { SqlClient } from "@effect/sql"
import { ClockService } from "@synchrotron/sync-core/ClockService"
import type { HLC } from "@synchrotron/sync-core/HLC"
import { Data, Effect, Schema } from "effect"
import { type ActionModifiedRow, type ActionRecord } from "./models" // Import ActionModifiedRow
import type { BadArgument } from "@effect/platform/Error"

export class RemoteActionFetchError extends Schema.TaggedError<RemoteActionFetchError>()(
	"RemoteActionFetchError",
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown)
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

export interface FetchResult {
	actions: readonly ActionRecord[]
	modifiedRows: readonly ActionModifiedRow[]
}

export interface BootstrapSnapshot {
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
		const sql = yield* SqlClient.SqlClient
		const clockService = yield* ClockService // Keep clockService dependency
		const clientId = yield* clockService.getNodeId // Keep clientId dependency

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
			fetchRemoteActions: (): Effect.Effect<FetchResult, RemoteActionFetchError | BadArgument> =>
				Effect.gen(function* () {
					const sinceServerIngestId = yield* clockService.getLastSeenServerIngestId
					// TODO: Implement actual network request to fetch remote actions
					// This would use fetch or another HTTP client to contact the sync server
					yield* Effect.logInfo(
						`Fetching remote actions since server_ingest_id=${sinceServerIngestId} for client ${clientId}`
					)

					// For now return empty array as placeholder
					// Need to return both actions and modifiedRows
					return { actions: [], modifiedRows: [] } as FetchResult
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
	): Effect.Effect<boolean, SendLocalActionsFailure | NetworkRequestError | BadArgument, never> =>
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
