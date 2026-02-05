import type { SqlClient } from "@effect/sql"
import { Effect, Option } from "effect"
import type { Action } from "../models"
import { ActionRecord } from "../models"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ClientClockState } from "../ClientClockState"
import type { ClientDbAdapterService } from "../ClientDbAdapter"
import type { DeterministicId } from "../DeterministicId"
import { ActionExecutionError } from "../SyncServiceErrors"

const collectErrorMessages = (error: unknown): ReadonlyArray<string> => {
	const messages = new Set<string>()
	const visited = new WeakSet<object>()

	const visit = (value: unknown, depth: number) => {
		if (depth > 6) return

		if (typeof value === "string") {
			messages.add(value)
			return
		}

		if (typeof value !== "object" || value === null) {
			messages.add(String(value))
			return
		}

		if (visited.has(value)) return
		visited.add(value)

		const maybeMessage = (value as { message?: unknown }).message
		if (typeof maybeMessage === "string") messages.add(maybeMessage)

		const cause = (value as { cause?: unknown }).cause
		if (cause !== undefined) visit(cause, depth + 1)

		const nestedError = (value as { error?: unknown }).error
		if (nestedError !== undefined) visit(nestedError, depth + 1)

		const reason = (value as { reason?: unknown }).reason
		if (reason !== undefined) visit(reason, depth + 1)
	}

	visit(error, 0)
	return Array.from(messages)
}

const detectIdCollision = (
	error: unknown
): { readonly tableName?: string; readonly idColumn?: string } | null => {
	const combinedMessage = collectErrorMessages(error).join("\n")

	// SQLite: "UNIQUE constraint failed: notes.id"
	const sqliteMatch = combinedMessage.match(/UNIQUE constraint failed: ([^.]+)\.([^\s]+)/)
	const sqliteTable = sqliteMatch?.[1]
	const sqliteColumn = sqliteMatch?.[2]
	if (
		typeof sqliteTable === "string" &&
		typeof sqliteColumn === "string" &&
		sqliteColumn === "id"
	) {
		return { tableName: sqliteTable, idColumn: sqliteColumn }
	}

	// Postgres/PGlite: "duplicate key value violates unique constraint ..."
	if (combinedMessage.includes("duplicate key value violates unique constraint")) {
		// Common Postgres detail: "Key (id)=(...) already exists."
		if (
			combinedMessage.includes("Key (id)=") ||
			combinedMessage.includes("Key (id) ") ||
			combinedMessage.includes("(id)=") ||
			combinedMessage.includes(" key (id)")
		) {
			return { idColumn: "id" }
		}

		// Some drivers omit the detail line but include the constraint name:
		// e.g. `duplicate key value violates unique constraint "notes_pkey"`
		const constraintMatch = combinedMessage.match(/unique constraint "([^"]+)"/i)
		const constraintName = constraintMatch?.[1]
		if (typeof constraintName === "string" && constraintName.toLowerCase().endsWith("_pkey")) {
			return {
				tableName: constraintName.slice(0, -"_pkey".length),
				idColumn: "id"
			}
		}
	}

	return null
}

export const makeExecuteAction = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly clientDbAdapter: ClientDbAdapterService
	readonly clockState: ClientClockState
	readonly actionRecordRepo: ActionRecordRepo
	readonly deterministicId: DeterministicId
	readonly clientId: string
}) => {
	const { sqlClient, clientDbAdapter, clockState, actionRecordRepo, deterministicId, clientId } =
		deps

	/**
	 * Execute an action and record it for later synchronization
	 *
	 * This will:
	 * 1. Start a transaction
	 * 2. Get the transaction ID
	 * 3. Increment the client's clock
	 * 4. Create an action record
	 * 5. Store the action record
	 * 6. Apply the action (which triggers database changes)
	 * 7. Return the updated action record with patches
	 */
	const executeAction = <A1, A extends Record<string, unknown>, EE, R>(
		action: Action<A1, A, EE, R>
	) =>
		Effect.gen(function* () {
			yield* Effect.logInfo(`Executing action: ${action._tag}`)
			// 1. Use an application-level transaction identifier.
			// We do not rely on database-specific transaction IDs (e.g. `txid_current()`), so this works on SQLite.
			const transactionId = Date.now()
			const executionTimestamp = new Date()
			const actionRecordId = crypto.randomUUID()

			const newClock = yield* clockState.incrementClock

			const timestampToUse =
				typeof action.args.timestamp === "number"
					? action.args.timestamp
					: executionTimestamp.getTime()

			const argsWithTimestamp: A & { timestamp: number } = {
				...action.args,
				timestamp: timestampToUse
			}
			yield* Effect.logInfo(`inserting new action record for ${action._tag}`)
			const toInsert = ActionRecord.insert.make({
				id: actionRecordId,
				client_id: clientId,
				clock: newClock,
				_tag: action._tag,
				args: argsWithTimestamp,
				created_at: executionTimestamp,
				synced: false,
				transaction_id: transactionId
			})
			yield* Effect.logInfo(`action record to insert: ${JSON.stringify(toInsert)}`)
			// 5. Store the action record
			const actionRecord = yield* actionRecordRepo
				.insert(toInsert)
				.pipe(
					Effect.tapErrorCause((e) =>
						Effect.logError(`Failed to store action record: ${action._tag}`, e)
					)
				)

			// Provide per-transaction patch-capture context (no-op on Postgres today, required for SQLite later).
			yield* clientDbAdapter.setCaptureContext(actionRecord.id)

			// 6. Apply the action (action-scoped deterministic ID generation is provided via DeterministicId)
			// and will throw an exception if the action fails
			// all changes, including the action record inserted above
			const result = yield* deterministicId.withActionContext(actionRecord.id, action.execute())

			// 7. Fetch the updated action record with patches
			const updatedRecord = yield* actionRecordRepo.findById(actionRecord.id)

			if (Option.isNone(updatedRecord)) {
				return yield* Effect.fail(
					new ActionExecutionError({
						actionId: action._tag,
						cause: new Error(`Failed to retrieve updated action record: ${actionRecord.id}`)
					})
				)
			}
			yield* actionRecordRepo.markLocallyApplied(updatedRecord.value.id)

			return { actionRecord: updatedRecord.value, result }
		}).pipe(
			sqlClient.withTransaction, // Restore transaction wrapper
			Effect.ensuring(clientDbAdapter.setCaptureContext(null).pipe(Effect.orDie)),
			Effect.catchAll((error) =>
				Effect.gen(function* () {
					yield* Effect.logError(`Error during action execution`, error)
					if (error instanceof ActionExecutionError) {
						return yield* Effect.fail(error)
					}

					const collision = detectIdCollision(error)
					if (collision) {
						const tableHint =
							typeof collision.tableName === "string"
								? ` (table "${collision.tableName}", column "${collision.idColumn ?? "id"}")`
								: ""

						const collisionError = new Error(
							`Row id collision while executing action "${action._tag}".` +
								tableHint +
								` This usually means the deterministic row identity for a tracked table is underspecified ` +
								`(or the action attempted to insert two rows with the same identity key). ` +
								`Fix: ensure every tracked table has an entry in DeterministicIdIdentityConfig ` +
								`(sync-client: rowIdentityByTable), and include a stable disambiguator in the identity ` +
								`key when creating multiple same-kind rows within one action.`
						)
						;(collisionError as any).cause = error

						return yield* Effect.fail(
							new ActionExecutionError({
								actionId: action._tag,
								cause: collisionError
							})
						)
					}

					return yield* Effect.fail(
						new ActionExecutionError({
							actionId: action._tag,
							cause: error
						})
					)
				})
			),
			Effect.annotateLogs({ clientId, actionTag: action._tag }),
			Effect.withSpan("SyncService.executeAction", {
				attributes: { clientId, actionTag: action._tag }
			})
		)

	return { executeAction } as const
}
