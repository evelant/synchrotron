import {
	ActionModifiedRow,
	ActionModifiedRowRepo,
	ActionRecord,
	ActionRecordRepo,
	FetchResult,
	NetworkRequestError,
	RemoteActionFetchError,
	SyncNetworkService
} from "@synchrotron/sync-core"
import { SqlClient } from "@effect/sql"
import { Effect, Layer, Schema } from "effect"
import * as HLC from "@synchrotron/sync-core/HLC"


/**
 * Server implementation of the SyncNetworkService.
 */
const makeSyncNetworkServiceServer = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const actionRepo = yield* ActionRecordRepo
	const amrRepo = yield* ActionModifiedRowRepo

	const fetchRemoteActions = (
		lastSyncedClock: HLC.HLC | null
	) =>
		Effect.gen(function* () {
			yield* Effect.logInfo("Server: Fetching remote actions")
			

			const actionsQuery = sql<ActionRecord>`
        SELECT * FROM action_records 
        WHERE hlc > ${lastSyncedClock?.toString() ?? HLC.make().toString()} 
        ORDER BY hlc ASC
      `
			const amrsQuery = sql<ActionModifiedRow>`
        SELECT * FROM action_modified_rows 
        WHERE action_hlc > ${lastSyncedClock?.toString() ?? HLC.make().toString()} // This might fetch too many AMRs, needs refinement.
      `

			const [actions, modifiedRows] = yield* 
				Effect.all([actionsQuery, amrsQuery])
			

			return { actions, modifiedRows }
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
	) =>
		Effect.gen(function* (_) {
			yield* Effect.logInfo(`Server: Receiving ${actions.length} actions, ${amrs.length} AMRs`)
			yield* sql.withTransaction(Effect.all([...actions.map(actionRepo.insert), ...amrs.map(amrRepo.insert)]))
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