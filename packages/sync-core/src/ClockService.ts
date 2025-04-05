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
				yield* Effect.logInfo(`using clientid override ${existingIdOption.value}`)
				return ClientId.make(existingIdOption.value)
			}

			const newClientId = crypto.randomUUID()
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
				last_synced_clock: initialClock
			})

			yield* sql`
				INSERT INTO client_sync_status ${sql.insert({
					client_id: initialStatus.client_id,
					current_clock: sql.json(initialStatus.current_clock),
					last_synced_clock: sql.json(initialStatus.last_synced_clock)
				})}
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
				`Incremented clock for client ${clientId}: from ${JSON.stringify(currentClock)} to ${JSON.stringify(newClock)}`
			)

			yield* clientSyncStatusRepo.update(
				ClientSyncStatusModel.update.make({
					client_id: clientId,
					current_clock: sql.json(newClock),
					last_synced_clock: sql.json(currentState.last_synced_clock)
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
				const latestSyncedClock = yield* actionRecordRepo
					.findLatestSynced()
					.pipe(
						Effect.map(Option.map((a) => a.clock)),
						Effect.flatMap(
							Effect.orElseFail(
								() =>
									new SyncError({ message: "No latest clock found to update last_synced_clock" })
							)
						)
					)

				const currentState = yield* getClientClockState

				if (HLC._order(latestSyncedClock, currentState.last_synced_clock) <= 0) {
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
						last_synced_clock: latestSyncedClock
					})
				)
			}).pipe(Effect.annotateLogs("clientId", clientId))

		/**
		 * Compare two clocks to determine their ordering
		 * Uses client ID as a tiebreaker if timestamps and vectors are identical.
		 */
		const compareClock = (
			a: { clock: HLC.HLC; clientId: string },
			b: { clock: HLC.HLC; clientId: string }
		): number => {
			return HLC.orderWithClientId(a.clock, b.clock, a.clientId, b.clientId)
		}

		/**
		 * Merge two clocks, taking the maximum values
		 */
		const mergeClock = (a: HLC.HLC, b: HLC.HLC): HLC.HLC => {
			return HLC.receiveRemoteMutation(a, b, clientId)
		}

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

		return {
			getNodeId,
			getClientClock,
			incrementClock,
			getLastSyncedClock,
			getEarliestClock,
			getLatestClock,
			updateLastSyncedClock,
			compareClock,
			mergeClock,
			sortClocks,
			findLatestCommonClock
		}
	}),
	accessors: true,
	dependencies: [ActionRecordRepo.Default]
}) {}
