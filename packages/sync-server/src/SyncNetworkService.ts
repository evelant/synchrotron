import {
	ActionModifiedRow,
	ActionModifiedRowRepo,
	ActionRecord,
	ActionRecordRepo,
	FetchResult,
	HLC,
	NetworkRequestError,
	RemoteActionFetchError,
	SyncNetworkService
} from "@synchrotron/sync-core"
import * as Sql from "@effect/sql"
import { Effect, Layer, Schema } from "effect"

// Helper to decode/construct error types from schema if needed elsewhere,
// but primarily we'll use the classes directly from sync-core.
const RemoteActionFetchErrorC = Schema.decodeUnknownSync(RemoteActionFetchError)
const NetworkRequestErrorC = Schema.decodeUnknownSync(NetworkRequestError)
const FetchResultC = Schema.decodeUnknownSync(FetchResult)

/**
 * Server implementation of the SyncNetworkService.
 */
const makeSyncNetworkServiceServer = Effect.gen(function* (_) {
	const sql = yield* _(Sql.SqlClient)
	const actionRepo = yield* _(ActionRecordRepo)
	const amrRepo = yield* _(ActionModifiedRowRepo)

	const fetchRemoteActions = (
		lastSyncedClock: HLC.HLC | null
	): Effect.Effect<FetchResult, RemoteActionFetchError> =>
		Effect.gen(function* (_) {
			yield* _(Effect.logInfo("Server: Fetching remote actions"))
			yield* _(
				Effect.annotateCurrentSpan("lastSyncedClock", lastSyncedClock?.toString() ?? "null")
			)

			// TODO: Refine query - should likely fetch AMRs associated with the fetched actions,
			// or based on a similar time range. This depends on the exact sync logic.
			const actionsQuery = sql<ActionRecord>`
        SELECT * FROM action_records 
        WHERE hlc > ${lastSyncedClock?.toString() ?? HLC.zero().toString()} 
        ORDER BY hlc ASC
      `
			const amrsQuery = sql<ActionModifiedRow>`
        SELECT * FROM action_modified_rows 
        WHERE action_hlc > ${lastSyncedClock?.toString() ?? HLC.zero().toString()}
      ` // This might fetch too many AMRs, needs refinement.

			const [actions, modifiedRows] = yield* _(
				Effect.all([sql(actionsQuery), sql(amrsQuery)])
			)

			return FetchResultC({ actions, modifiedRows }) // Construct FetchResult
		}).pipe(
			Effect.catchTag("SqlError", (e) =>
				Effect.fail(
					new RemoteActionFetchError({ message: `DB Error: ${e.message}`, cause: e })
				)
			),
			Effect.withSpan("SyncNetworkServiceServer.fetchRemoteActions")
		)

	const sendLocalActions = (
		actions: ReadonlyArray<ActionRecord>,
		amrs: ReadonlyArray<ActionModifiedRow>
	): Effect.Effect<boolean, NetworkRequestError> =>
		Effect.gen(function* (_) {
			yield* _(Effect.logInfo(`Server: Receiving ${actions.length} actions, ${amrs.length} AMRs`))
			// Insert within a transaction
			yield* _(sql.withTransaction(Effect.all([actionRepo.insertMany(actions), amrRepo.insertMany(amrs)])))
			return true
		}).pipe(
			Effect.catchTag("SqlError", (e) =>
				Effect.fail(new NetworkRequestError({ message: `DB Error: ${e.message}`, cause: e }))
			),
			Effect.withSpan("SyncNetworkServiceServer.sendLocalActions")
		)

	return SyncNetworkService.of({ fetchRemoteActions, sendLocalActions })
})

/**
 * Live Layer for the server SyncNetworkService.
 */
export const SyncNetworkServiceServiceLive = Layer.effect(
	SyncNetworkService,
	makeSyncNetworkServiceServer
)