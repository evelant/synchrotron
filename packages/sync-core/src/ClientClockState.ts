import { SqlClient, SqlSchema } from "@effect/sql"
import { makeRepository } from "@effect/sql/Model"
import { Effect, Option, Schema } from "effect"
import { compareClock } from "./ClockOrder"
import { ClientIdentity } from "./ClientIdentity"
import * as HLC from "./HLC"
import { ActionRecordRepo } from "./ActionRecordRepo"
import { ClientSyncStatusModel, type ClientId } from "./models"

export class ClientClockStateError extends Schema.TaggedError<ClientClockStateError>()(
	"ClientClockStateError",
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown)
	}
) {}

/**
 * ClientClockState persists client-local sync state (HLC + cursors) in the local database.
 *
 * It intentionally does NOT manage client identity storage; use `ClientIdentity` for that.
 */
export class ClientClockState extends Effect.Service<ClientClockState>()("ClientClockState", {
	accessors: true,
	effect: Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		const actionRecordRepo = yield* ActionRecordRepo
		const identity = yield* ClientIdentity

		const getClientId = identity.get

		const clientSyncStatusRepo = yield* makeRepository(ClientSyncStatusModel, {
			tableName: "client_sync_status",
			idColumn: "client_id",
			spanPrefix: "ClientSyncStatus"
		})

		const findClientSyncStatus = SqlSchema.findOne({
			Request: Schema.String,
			Result: ClientSyncStatusModel,
			execute: (clientId) => sql`SELECT * FROM client_sync_status WHERE client_id = ${clientId}`
		})

		const getClientSyncStatus = Effect.gen(function* () {
			const clientId = (yield* getClientId) as ClientId
			const existing = yield* findClientSyncStatus(clientId)

			if (Option.isSome(existing)) return existing.value

			const initialClock = HLC.make()
			yield* sql`
				INSERT INTO client_sync_status (
					client_id,
					current_clock,
					last_synced_clock,
					server_epoch,
					last_seen_server_ingest_id
				) VALUES (
					${clientId},
					${JSON.stringify(initialClock)},
					${JSON.stringify(initialClock)},
					NULL,
					0
				)
				ON CONFLICT (client_id) DO NOTHING
			`

			const created = yield* findClientSyncStatus(clientId)
			if (Option.isSome(created)) return created.value

			return yield* Effect.fail(
				new ClientClockStateError({
					message: "Failed to create or fetch initial client_sync_status row"
				})
			)
		})

		const getCurrentClock = Effect.map(getClientSyncStatus, (s) => s.current_clock)

		const incrementClock = Effect.gen(function* () {
			const state = yield* getClientSyncStatus
			const clientId = (yield* getClientId) as ClientId
			const next = HLC.createLocalMutation(state.current_clock, clientId)

			yield* clientSyncStatusRepo.update(
				ClientSyncStatusModel.update.make({
					client_id: clientId,
					current_clock: next,
					last_synced_clock: state.last_synced_clock,
					server_epoch: state.server_epoch,
					last_seen_server_ingest_id: state.last_seen_server_ingest_id
				})
			)

			return next
		})

		const observeRemoteClocks = (remoteClocks: ReadonlyArray<HLC.HLC>) =>
			Effect.gen(function* () {
				if (remoteClocks.length === 0) return yield* getCurrentClock

				const state = yield* getClientSyncStatus
				const clientId = (yield* getClientId) as ClientId

				let next = state.current_clock
				for (const remote of remoteClocks) {
					next = HLC.receiveRemoteMutation(next, remote, clientId)
				}

				yield* clientSyncStatusRepo.update(
					ClientSyncStatusModel.update.make({
						client_id: clientId,
						current_clock: next,
						last_synced_clock: state.last_synced_clock,
						server_epoch: state.server_epoch,
						last_seen_server_ingest_id: state.last_seen_server_ingest_id
					})
				)

				return next
			})

		const getLastSyncedClock = Effect.map(getClientSyncStatus, (s) => s.last_synced_clock)

		const updateLastSyncedClock = () =>
			Effect.gen(function* () {
				const clientId = (yield* getClientId) as ClientId
				const latestSyncedClock = yield* actionRecordRepo.findLatestSynced().pipe(
					Effect.map(Option.map((a) => a.clock)),
					Effect.flatMap(
						Effect.orElse(() =>
							actionRecordRepo.findLatest().pipe(
								Effect.map(Option.map((a) => a.clock)),
								Effect.flatMap(
									Effect.orElseFail(
										() =>
											new ClientClockStateError({
												message: "No action_records exist to derive last_synced_clock"
											})
									)
								)
							)
						)
					)
				)

				const state = yield* getClientSyncStatus
				if (
					compareClock(
						{ clock: latestSyncedClock, clientId, id: undefined },
						{ clock: state.last_synced_clock, clientId, id: undefined }
					) <= 0
				) {
					return
				}

				yield* clientSyncStatusRepo.update(
					ClientSyncStatusModel.update.make({
						client_id: clientId,
						current_clock: state.current_clock,
						last_synced_clock: latestSyncedClock,
						server_epoch: state.server_epoch,
						last_seen_server_ingest_id: state.last_seen_server_ingest_id
					})
				)
			})

		const getLastSeenServerIngestId = Effect.map(
			getClientSyncStatus,
			(s) => s.last_seen_server_ingest_id
		)

		const advanceLastSeenServerIngestId = (latestSeen: number) =>
			Effect.gen(function* () {
				const state = yield* getClientSyncStatus
				if (latestSeen <= state.last_seen_server_ingest_id) return

				const clientId = (yield* getClientId) as ClientId
				yield* clientSyncStatusRepo.update(
					ClientSyncStatusModel.update.make({
						client_id: clientId,
						current_clock: state.current_clock,
						last_synced_clock: state.last_synced_clock,
						server_epoch: state.server_epoch,
						last_seen_server_ingest_id: latestSeen
					})
				)
			})

		const getServerEpoch = Effect.map(getClientSyncStatus, (s) => s.server_epoch)

		const setServerEpoch = (serverEpoch: string) =>
			Effect.gen(function* () {
				const state = yield* getClientSyncStatus
				if (state.server_epoch === serverEpoch) return

				const clientId = (yield* getClientId) as ClientId
				yield* clientSyncStatusRepo.update(
					ClientSyncStatusModel.update.make({
						client_id: clientId,
						current_clock: state.current_clock,
						last_synced_clock: state.last_synced_clock,
						server_epoch: serverEpoch,
						last_seen_server_ingest_id: state.last_seen_server_ingest_id
					})
				)
			})

		return {
			getClientId,
			getClientSyncStatus,
			getCurrentClock,
			incrementClock,
			observeRemoteClocks,
			getLastSyncedClock,
			updateLastSyncedClock,
			getLastSeenServerIngestId,
			advanceLastSeenServerIngestId,
			getServerEpoch,
			setServerEpoch
		} as const
	}),
	dependencies: [ActionRecordRepo.Default]
}) {}
