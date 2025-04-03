import { KeyValueStore } from "@effect/platform"
import { SqlSchema } from "@effect/sql"
import { PgLiteClient } from "@effect/sql-pglite"
import { makeRepository } from "@effect/sql/Model"
import { ActionRecordRepo } from "@synchrotron/sync-core/ActionRecordRepo"
import { Effect, Option, Schema } from "effect"
import { ClientIdOverride } from "./ClientIdOverride"
import * as HLC from "./HLC"
import { ClientId, ClientSyncStatusModel, type ActionRecord } from "./models"
import { SyncError } from "@synchrotron/sync-core/SyncService"

/**
 * Service that manages Hybrid Logical Clocks (HLCs) for establishing
 * causal ordering of actions across distributed clients
 */
export class ClockService extends Effect.Service<ClockService>()("ClockService", {
	// Define E and R explicitly for the service effect
	effect: Effect.gen(function* () {
		const sql = yield* PgLiteClient.PgLiteClient
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
			// Check if we have an override client ID (used for testing)

			if (overrideOption._tag === "Some") {
				return ClientId.make(overrideOption.value)
			}

			// Normal production flow - get from key-value store or generate new
			const existingIdOption = yield* keyValueStore.get("sync_client_id")

			if (existingIdOption._tag === "Some") {
				yield* Effect.logInfo(`using clientid override ${existingIdOption.value}`)
				return ClientId.make(existingIdOption.value)
			}

			// Generate and store a new client ID
			const newClientId = crypto.randomUUID()
			yield* keyValueStore.set("sync_client_id", newClientId)
			const clientId = ClientId.make(newClientId)
			return clientId
		})

		const clientId = yield* getNodeId

		// Create a repository for client sync status
		const clientSyncStatusRepo = yield* makeRepository(ClientSyncStatusModel, {
			tableName: "client_sync_status",
			idColumn: "client_id",
			spanPrefix: `ClientSyncStatus-${clientId}`
		})

		// Define type-safe queries using SqlSchema
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
			// If no record, create one with initial empty/default clocks
			const initialClock = HLC.make()
			const initialStatus = ClientSyncStatusModel.make({
				client_id: clientId,
				current_clock: initialClock, // Initialize current_clock
				last_synced_clock: initialClock // Initialize last_synced_clock
			})

			yield* sql`
				INSERT INTO client_sync_status ${sql.insert({
					client_id: initialStatus.client_id,
					current_clock: sql.json(initialStatus.current_clock),
					last_synced_clock: sql.json(initialStatus.last_synced_clock) // Insert new field
				})}
				ON CONFLICT (client_id)
				DO NOTHING -- If it exists concurrently, let the existing value stand
			`
			// Re-fetch after potential insert/conflict
			const finalStatus = yield* findClientClock(clientId)
			if (finalStatus._tag === "Some") return finalStatus.value
			// This should be unreachable if insert/fetch works
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

			// Create the new clock with incremented vector value for this client
			const newClock = HLC.createLocalMutation(currentClock, clientId)

			yield* Effect.logInfo(
				`Incremented clock for client ${clientId}: from ${JSON.stringify(currentClock)} to ${JSON.stringify(newClock)}`
			)

			// Use the repository to update the record
			yield* clientSyncStatusRepo.update(
				ClientSyncStatusModel.update.make({
					client_id: clientId,
					current_clock: newClock, // Update current_clock
					// last_synced_clock remains unchanged here
					last_synced_clock: currentState.last_synced_clock
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

				// Only update if the latest sent clock is actually newer than the current last_synced_clock
				if (HLC._order(latestSyncedClock, currentState.last_synced_clock) <= 0) {
					yield* Effect.logDebug(
						`Skipping last_synced_clock update: latest sent clock ${JSON.stringify(latestSyncedClock)} is not newer than current last_synced_clock ${JSON.stringify(currentState.last_synced_clock)}`
					)
					return // No update needed
				}

				yield* Effect.logInfo(
					`Updating last_synced_clock after send for client ${clientId} to ${JSON.stringify(latestSyncedClock)}`
				)

				yield* clientSyncStatusRepo.update(
					ClientSyncStatusModel.update.make({
						client_id: clientId,
						current_clock: currentState.current_clock, // Keep current clock the same
						last_synced_clock: latestSyncedClock // Update only last_synced_clock
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
			// Use the HLC function that includes client ID tiebreaking
			return HLC.orderWithClientId(a.clock, b.clock, a.clientId, b.clientId)
		}

		/**
		 * Merge two clocks, taking the maximum values
		 */
		const mergeClock = (a: HLC.HLC, b: HLC.HLC): HLC.HLC => {
			// Use HLC.receiveRemoteMutation for proper merging
			return HLC.receiveRemoteMutation(a, b, clientId)
		}

		/**
		 * Sort an array of clocks in ascending order
		 */
		const sortClocks = <
			T extends { clock: HLC.HLC; clientId: string } // Ensure items have clientId
		>(
			items: T[]
		): T[] => {
			// Pass the objects containing clock and clientId to compareClock
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
			// Find all synced actions that could be common ancestors
			const syncedActions = localActions.filter((a) => a.synced === true)

			// Map actions to include clientId property expected by sortClocks
			const syncedActionsWithClientId = syncedActions.map((a) => ({
				...a,
				clientId: a.client_id // Map client_id to clientId
			}))

			if (syncedActionsWithClientId.length === 0) {
				return null
			}

			// Sort in descending order (newest first)
			const sortedSynced = sortClocks(syncedActionsWithClientId).reverse()

			const remoteClocks = remoteActions.map((a) => a.clock)

			// Find the newest synced action that comes before all remote actions
			for (const action of sortedSynced) {
				if (remoteClocks.every((remoteClock) => HLC.isBefore(action.clock, remoteClock))) {
					return action.clock
				}
			}

			// If no suitable clock found, return null
			return null
		}

		/** Helper to get the clock of the earliest action in a list */
		const getEarliestClock = (actions: readonly ActionRecord[]): Option.Option<HLC.HLC> => {
			if (actions.length === 0) return Option.none()
			// Ensure array is not empty before accessing index
			// Map actions to include clientId for sorting
			const actionsWithClientId = actions.map((a) => ({ ...a, clientId: a.client_id }))
			const sorted = sortClocks(actionsWithClientId)
			// Need to check if sorted[0] exists due to noUncheckedIndexAccess
			return sorted[0] ? Option.some(sorted[0].clock) : Option.none()
		}

		/** Helper to get the clock of the latest action in a list */
		const getLatestClock = (actions: readonly ActionRecord[]): Option.Option<HLC.HLC> => {
			if (actions.length === 0) return Option.none()
			// Ensure array is not empty before accessing index
			// Map actions to include clientId for sorting
			const actionsWithClientId = actions.map((a) => ({ ...a, clientId: a.client_id }))
			const sorted = sortClocks(actionsWithClientId)
			// Need to check if sorted[sorted.length - 1] exists
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
			updateLastSyncedClock, // Add the new method
			compareClock,
			mergeClock,
			sortClocks,
			findLatestCommonClock
		}
	}),
	accessors: true
}) {}
