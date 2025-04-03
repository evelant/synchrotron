import { SqlClient } from "@effect/sql"
import { ClockService } from "@synchrotron/sync-core/ClockService"
import { Data, Effect } from "effect"
import { type ActionModifiedRow, type ActionRecord } from "./models" // Import ActionModifiedRow

/**
 * SyncNetworkService errors
 */
export class RemoteActionFetchError extends Data.TaggedError("RemoteActionFetchError")<{
	message: string
	cause?: unknown
}> {}

export class NetworkRequestError extends Data.TaggedError("NetworkRequestError")<{
	message: string
	cause?: unknown
}> {}

// Define the return type for fetchRemoteActions
export interface FetchResult {
	actions: readonly ActionRecord[]
	modifiedRows: readonly ActionModifiedRow[]
}

/**
 * SyncNetworkService tag definition
 * Responsible for handling network communication with sync server
 */
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
			fetchRemoteActions: (): Effect.Effect<FetchResult, RemoteActionFetchError> => // Update return type
				Effect.gen(function* () {
					const lastSyncedClock = yield* clockService.getLastSyncedClock
					// TODO: Implement actual network request to fetch remote actions
					// This would use fetch or another HTTP client to contact the sync server
					yield* Effect.logInfo(
						`Fetching remote actions since ${JSON.stringify(lastSyncedClock)} for client ${clientId}`
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

			sendLocalActions: (actions: readonly ActionRecord[], amrs: readonly ActionModifiedRow[]) =>
				Effect.gen(function* () {
					// TODO: Implement actual network request to send actions to remote server
					yield* Effect.logInfo(`Sending ${actions.length} local actions to server`)

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
