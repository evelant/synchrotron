import { KeyValueStore } from "@effect/platform"
import { SqlClient, SqlSchema } from "@effect/sql"
import { makeRepository } from "@effect/sql/Model"
import { ActionRecordRepo } from "@synchrotron/sync-core/ActionRecordRepo"
import { SyncError } from "@synchrotron/sync-core/SyncService"
import { Effect, Option, Schema } from "effect"
import { ClientIdOverride } from "./ClientIdOverride"
import * as HLC from "./HLC"
import { ClientId, ClientSyncStatusModel, type ActionRecord } from "./models"

/**
 * Service that manages Hybrid Logical Clocks (HLCs) for establishing
 * causal ordering of actions across distributed clients
 */
export class ClockService extends Effect.Service<ClockService>()("ClockService", {
	effect: Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		const keyValueStore = yield* KeyValueStore.KeyValueStore
		const overrideOption = yield* Effect.serviceOption(ClientIdOverride)
		const actionRecordRepo = yield* ActionRecordRepo

		/**
		 * Get or generate a unique client ID for this device
		 *
		 * In test environments, this can be overridden with an explicit client ID
		 * via the ClientIdOverride service
		 */
		const getNodeId = Effect.gen(function* () {
			if (overrideOption._tag === "Some") {
				return ClientId.make(overrideOption.value)
			}

			const existingIdOption = yield* keyValueStore.get("sync_client_id")

			if (existingIdOption._tag === "Some") {
				// yield* Effect.logInfo(`using clientid  ${existingIdOption.value}`)
				return ClientId.make(existingIdOption.value)
			}

			const newClientId = crypto.randomUUID()
			yield* Effect.logInfo(
				`No client id found in key-value store. Generating new. Client id: ${newClientId}`
			)

			yield* keyValueStore.set("sync_client_id", newClientId)
			const clientId = ClientId.make(newClientId)
			return clientId
		})

		const clientId = yield* getNodeId

		const clientSyncStatusRepo = yield* makeRepository(ClientSyncStatusModel, {
			tableName: "client_sync_status",
			idColumn: "client_id",
			spanPrefix: `ClientSyncStatus-${clientId}`
		})

		const findClientClock = SqlSchema.findOne({
			Request: Schema.String,
			Result: ClientSyncStatusModel,
			execute: (clientId) => sql`
					SELECT * FROM client_sync_status
					WHERE client_id = ${clientId}
				`
		})

		/**
		 * Retrieve the current client clock state (including last synced)
		 */
		const getClientClockState = Effect.gen(function* () {
			const clientId = yield* getNodeId
			const clientStatus = yield* findClientClock(clientId)

			if (clientStatus._tag === "Some") {
				return clientStatus.value
			}

			yield* Effect.logInfo(`No client sync status found for client ${clientId}, creating.`)
			const initialClock = HLC.make()
			const initialStatus = ClientSyncStatusModel.make({
				client_id: clientId,
				current_clock: initialClock,
				last_synced_clock: initialClock,
				last_seen_server_ingest_id: 0
			})

			yield* sql`
				INSERT INTO client_sync_status (
					client_id,
					current_clock,
					last_synced_clock,
					last_seen_server_ingest_id
				) VALUES (
					${initialStatus.client_id},
					${JSON.stringify(initialStatus.current_clock)},
					${JSON.stringify(initialStatus.last_synced_clock)},
					${initialStatus.last_seen_server_ingest_id}
				)
				ON CONFLICT (client_id)
				DO NOTHING
			`
			const finalStatus = yield* findClientClock(clientId)
			if (finalStatus._tag === "Some") return finalStatus.value
			return yield* Effect.die("Failed to create or fetch initial client sync status")
		}).pipe(Effect.annotateLogs("clientId", clientId))

		/**
		 * Retrieve the current client clock (latest state, potentially unsynced)
		 */
		const getClientClock = Effect.map(getClientClockState, (state) => state.current_clock)

		/**
		 * Increment the client's current clock for a new local action
		 */
		const incrementClock = Effect.gen(function* () {
			const currentState = yield* getClientClockState
			const currentClock = currentState.current_clock

			const newClock = HLC.createLocalMutation(currentClock, clientId)

			yield* Effect.logInfo(
				`Incremented clock for client ${clientId}: from ${JSON.stringify(currentClock)} to ${JSON.stringify(newClock)} ${JSON.stringify(currentState)}`
			)

			yield* clientSyncStatusRepo.update(
				ClientSyncStatusModel.update.make({
					client_id: clientId,
					current_clock: newClock,
					last_synced_clock: currentState.last_synced_clock,
					last_seen_server_ingest_id: currentState.last_seen_server_ingest_id
				})
			)

			return newClock
		}).pipe(Effect.annotateLogs("clientId", clientId))

		/**
		 * Update only the client's last synced clock after successfully sending local actions.
		 * This prevents fetching our own actions back. The current_clock remains unchanged.
		 */
		const updateLastSyncedClock = () =>
			Effect.gen(function* () {
				// Get latest synced clock, or if none latest unsynced clock
				const latestSyncedClock = yield* actionRecordRepo.findLatestSynced().pipe(
					Effect.map(Option.map((a) => a.clock)),
					Effect.flatMap(
						Effect.orElse(() =>
							actionRecordRepo.findLatest().pipe(
								Effect.map(Option.map((a) => a.clock)),
								Effect.flatMap(
									Effect.orElseFail(
										() =>
											new SyncError({
												message: "No latest clock found to update last_synced_clock"
											})
									)
								)
							)
						)
					)
				)

				const currentState = yield* getClientClockState

				if (
					compareClock(
						{ clock: latestSyncedClock, clientId, id: undefined },
						{ clock: currentState.last_synced_clock, clientId, id: undefined }
					) <= 0
				) {
					yield* Effect.logDebug(
						`Skipping last_synced_clock update: latest sent clock ${JSON.stringify(latestSyncedClock)} is not newer than current last_synced_clock ${JSON.stringify(currentState.last_synced_clock)}`
					)
					return
				}

				yield* Effect.logInfo(
					`Updating last_synced_clock after send for client ${clientId} to ${JSON.stringify(latestSyncedClock)}`
				)

				yield* clientSyncStatusRepo.update(
					ClientSyncStatusModel.update.make({
						client_id: clientId,
						current_clock: currentState.current_clock,
						last_synced_clock: latestSyncedClock,
						last_seen_server_ingest_id: currentState.last_seen_server_ingest_id
					})
				)
			}).pipe(Effect.annotateLogs("clientId", clientId))

		/**
		 * Compare two clocks to determine their ordering
		 * Canonical total order: (time_ms, counter, node_id, action_id)
		 *
		 * For non-action comparisons, `id` can be omitted.
		 */
		const compareClock = (
			a: { clock: HLC.HLC; clientId: string; id?: string | number | undefined },
			b: { clock: HLC.HLC; clientId: string; id?: string | number | undefined }
		): number => {
			if (a.clock.timestamp !== b.clock.timestamp) {
				return a.clock.timestamp < b.clock.timestamp ? -1 : 1
			}

			const counterA = HLC.valueForNode(a.clock, a.clientId)
			const counterB = HLC.valueForNode(b.clock, b.clientId)
			if (counterA !== counterB) {
				return counterA < counterB ? -1 : 1
			}

			if (a.clientId !== b.clientId) {
				return a.clientId < b.clientId ? -1 : 1
			}

			const idA = a.id === undefined ? "" : String(a.id)
			const idB = b.id === undefined ? "" : String(b.id)
			if (idA !== idB) {
				return idA < idB ? -1 : 1
			}

			return 0
		}

			/**
			 * Merge two clocks, taking the maximum values
			 */
			const mergeClock = (a: HLC.HLC, b: HLC.HLC): HLC.HLC => {
				return HLC.receiveRemoteMutation(a, b, clientId)
			}

			/**
			 * Observe remote clocks by merging them into the current clock state.
			 *
			 * This ensures that subsequent local actions carry vector-causality information about
			 * the remote actions the client has applied, and that local HLC time doesn't regress
			 * relative to far-future remote timestamps.
			 */
			const observeRemoteClocks = (remoteClocks: ReadonlyArray<HLC.HLC>) =>
				Effect.gen(function* () {
					if (remoteClocks.length === 0) return yield* getClientClock

					const currentState = yield* getClientClockState
					let nextClock = currentState.current_clock
					for (const remoteClock of remoteClocks) {
						nextClock = HLC.receiveRemoteMutation(nextClock, remoteClock, clientId)
					}

					yield* clientSyncStatusRepo.update(
						ClientSyncStatusModel.update.make({
							client_id: clientId,
							current_clock: nextClock,
							last_synced_clock: currentState.last_synced_clock,
							last_seen_server_ingest_id: currentState.last_seen_server_ingest_id
						})
					)

					return nextClock
				}).pipe(Effect.annotateLogs("clientId", clientId))

			/**
			 * Sort an array of clocks in ascending order
			 */
			const sortClocks = <T extends { clock: HLC.HLC; clientId: string }>(items: T[]): T[] => {
				return [...items].sort((a, b) => compareClock(a, b))
		}

		/**
		 * Find the latest common ancestor between two sets of actions
		 * This is used to determine the rollback point for conflict resolution
		 */
		const findLatestCommonClock = <
			T extends {
				clock: HLC.HLC
				synced: boolean | undefined
				client_id: string // Assuming action records have client_id
			}
		>(
			localActions: T[],
			remoteActions: T[]
		): HLC.HLC | null => {
			const syncedActions = localActions.filter((a) => a.synced === true)

			const syncedActionsWithClientId = syncedActions.map((a) => ({
				...a,
				clientId: a.client_id
			}))

			if (syncedActionsWithClientId.length === 0) {
				return null
			}

			const sortedSynced = sortClocks(syncedActionsWithClientId).reverse()

			const remoteClocks = remoteActions.map((a) => a.clock)

			for (const action of sortedSynced) {
				if (remoteClocks.every((remoteClock) => HLC.isBefore(action.clock, remoteClock))) {
					return action.clock
				}
			}

			return null
		}

		/** Helper to get the clock of the earliest action in a list */
		const getEarliestClock = (actions: readonly ActionRecord[]): Option.Option<HLC.HLC> => {
			if (actions.length === 0) return Option.none()
			const actionsWithClientId = actions.map((a) => ({ ...a, clientId: a.client_id }))
			const sorted = sortClocks(actionsWithClientId)
			return sorted[0] ? Option.some(sorted[0].clock) : Option.none()
		}

		/** Helper to get the clock of the latest action in a list */
		const getLatestClock = (actions: readonly ActionRecord[]): Option.Option<HLC.HLC> => {
			if (actions.length === 0) return Option.none()
			const actionsWithClientId = actions.map((a) => ({ ...a, clientId: a.client_id }))
			const sorted = sortClocks(actionsWithClientId)
			const lastAction = sorted[sorted.length - 1]
			return lastAction ? Option.some(lastAction.clock) : Option.none()
		}

		/**
		 * Retrieve the clock representing the last known synced state from the database.
		 */
		const getLastSyncedClock = Effect.map(
			getClientClockState,
			(state) => state.last_synced_clock
		).pipe(Effect.annotateLogs("clientId", clientId))

		const getLastSeenServerIngestId = Effect.map(
			getClientClockState,
			(state) => state.last_seen_server_ingest_id
		).pipe(Effect.annotateLogs("clientId", clientId))

		const advanceLastSeenServerIngestId = (latestSeen: number) =>
			Effect.gen(function* () {
				const currentState = yield* getClientClockState

				if (latestSeen <= currentState.last_seen_server_ingest_id) {
					yield* Effect.logDebug(
						`Skipping last_seen_server_ingest_id update: latest seen ${latestSeen} is not newer than current ${currentState.last_seen_server_ingest_id}`
					)
					return
				}

				yield* Effect.logInfo(
					`Updating last_seen_server_ingest_id for client ${clientId} to ${latestSeen}`
				)

				yield* clientSyncStatusRepo.update(
					ClientSyncStatusModel.update.make({
						client_id: clientId,
						current_clock: currentState.current_clock,
						last_synced_clock: currentState.last_synced_clock,
						last_seen_server_ingest_id: latestSeen
					})
				)
			}).pipe(Effect.annotateLogs("clientId", clientId))

		return {
			getNodeId,
			getClientClock,
			incrementClock,
			getLastSyncedClock,
			getLastSeenServerIngestId,
				advanceLastSeenServerIngestId,
				getEarliestClock,
				getLatestClock,
				updateLastSyncedClock,
				compareClock,
				mergeClock,
				observeRemoteClocks,
				sortClocks,
				findLatestCommonClock
			}
		}),
	accessors: true,
	dependencies: [ActionRecordRepo.Default]
}) {}
