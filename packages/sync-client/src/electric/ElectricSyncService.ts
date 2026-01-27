import { SqlClient } from "@effect/sql"
import type { Row } from "@electric-sql/client"

import { isChangeMessage, isControlMessage } from "@electric-sql/client"
import { TransactionalMultiShapeStream, type MultiShapeMessages } from "@electric-sql/experimental"
import { SyncService, ingestRemoteSyncLogBatch } from "@synchrotron/sync-core"
import type { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"
import { Effect, Ref, Schema, Stream } from "effect"
import { SynchrotronClientConfig } from "../config"

export class ElectricSyncError extends Schema.TaggedError<ElectricSyncError>()(
	"ElectricSyncError",
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown)
	}
) {}

export class ElectricSyncService extends Effect.Service<ElectricSyncService>()(
	"ElectricSyncService",
	{
		scoped: Effect.gen(function* () {
			yield* Effect.logInfo(`creating ElectricSyncService`)
			const syncService = yield* SyncService
			const config = yield* SynchrotronClientConfig
			const sql = yield* SqlClient.SqlClient
			const fullySyncedRef = yield* Ref.make(false)
			const electricUrl = config.electricSyncUrl
			yield* Effect.logInfo(`Creating TransactionalMultiShapeStream`)

			const multiShapeStream = yield* Effect.tryPromise({
				try: async () => {
					return new TransactionalMultiShapeStream<{
						action_records: Row
						action_modified_rows: Row
					}>({
						shapes: {
							action_records: {
								url: `${electricUrl}/v1/shape`,
								params: { table: "action_records" }
							},
							action_modified_rows: {
								url: `${electricUrl}/v1/shape`,
								params: { table: "action_modified_rows" }
							}
						}
					})
				},
				catch: (e) =>
					new ElectricSyncError({
						message: `Failed to create TransactionalMultiShapeStream: ${e instanceof Error ? e.message : String(e)}`,
						cause: e
					})
			})

			// Create a single stream for all shape messages
			const multiShapeMessagesStream = Stream.asyncScoped<
				MultiShapeMessages<{
					action_records: Row
					action_modified_rows: Row
				}>[],
				ElectricSyncError
			>((emit) =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Subscribing to TransactionalMultiShapeStream")
					return yield* Effect.acquireRelease(
						Effect.sync(() =>
							multiShapeStream.subscribe(
								(messages) => {
									emit.single(messages)
								},
								(error: unknown) => {
									emit.fail(
										new ElectricSyncError({
											message: `MultiShapeStream error: ${error instanceof Error ? error.message : String(error)}`,
											cause: error
										})
									)
								}
							)
						),
						(unsub) =>
							Effect.gen(function* () {
								yield* Effect.logInfo("Unsubscribing from TransactionalMultiShapeStream")
								unsub()
							})
					)
				})
			)

			yield* multiShapeMessagesStream.pipe(
				// Process each batch of messages
				Stream.tap((messages) =>
					Effect.logTrace(
						`Multi-shape sync batch received: ${JSON.stringify(messages, (_, v) => (typeof v === "bigint" ? `BIGINT: ${v.toString()}` : v), 2)}`
					)
				),
				Stream.flatMap((messages) =>
					Stream.fromEffect(
						Effect.gen(function* () {
							const requireString = (row: Row, key: string): string => {
								const value = row[key]
								if (typeof value === "string") return value
								throw new ElectricSyncError({
									message: `Expected "${key}" to be a string, got: ${typeof value}`,
									cause: value
								})
							}

							const optionalString = (row: Row, key: string): string | null => {
								const value = row[key]
								if (value === null || value === undefined) return null
								if (typeof value === "string") return value
								throw new ElectricSyncError({
									message: `Expected "${key}" to be a string, null, or undefined, got: ${typeof value}`,
									cause: value
								})
							}

							const optionalNumberFromValue = (row: Row, key: string): number | null => {
								const value = row[key]
								if (value === null || value === undefined) return null
								if (typeof value === "number") return value
								if (typeof value === "bigint") return Number(value)
								if (typeof value === "string") {
									const parsed = Number(value)
									if (Number.isFinite(parsed)) return parsed
								}
								throw new ElectricSyncError({
									message: `Expected "${key}" to be a number, bigint, stringified number, or null`,
									cause: value
								})
							}

							const requireNumberFromValue = (row: Row, key: string): number => {
								const value = row[key]
								if (typeof value === "number") return value
								if (typeof value === "bigint") return Number(value)
								if (typeof value === "string") {
									const parsed = Number(value)
									if (Number.isFinite(parsed)) return parsed
								}
								throw new ElectricSyncError({
									message: `Expected "${key}" to be a number, bigint, or stringified number`,
									cause: value
								})
							}

							const parseJsonColumn = (row: Row, key: string): unknown => {
								const value = row[key]
								if (typeof value === "string") {
									try {
										return JSON.parse(value)
									} catch (e) {
										throw new ElectricSyncError({
											message: `Expected "${key}" to be valid JSON, got string: ${value}`,
											cause: e
										})
									}
								}
								return value
							}

							const requireJsonObjectColumn = (row: Row, key: string): Record<string, unknown> => {
								const value = parseJsonColumn(row, key)
								if (value === null || value === undefined) {
									throw new ElectricSyncError({
										message: `Expected "${key}" to be a JSON object, got null/undefined`
									})
								}
								if (typeof value !== "object" || Array.isArray(value)) {
									throw new ElectricSyncError({
										message: `Expected "${key}" to be a JSON object, got: ${typeof value}`,
										cause: value
									})
								}
								return value as Record<string, unknown>
							}

							const jsonObjectColumnOrEmpty = (row: Row, key: string): Record<string, unknown> => {
								const value = parseJsonColumn(row, key)
								if (value === null || value === undefined) return {}
								if (typeof value !== "object" || Array.isArray(value)) {
									throw new ElectricSyncError({
										message: `Expected "${key}" to be a JSON object, got: ${typeof value}`,
										cause: value
									})
								}
								return value as Record<string, unknown>
							}

							const requireDbBoolean = (row: Row, key: string): 0 | 1 => {
								const value = row[key]
								if (typeof value === "boolean") return value ? 1 : 0
								if (value === 0 || value === 1) return value
								if (typeof value === "number" && (value === 0 || value === 1)) {
									return value
								}
								if (typeof value === "string") {
									if (value === "0") return 0
									if (value === "1") return 1
									if (value.toLowerCase() === "true" || value.toLowerCase() === "t") return 1
									if (value.toLowerCase() === "false" || value.toLowerCase() === "f") return 0
								}
								throw new ElectricSyncError({
									message: `Expected "${key}" to be a boolean-ish value (boolean, 0|1, or string), got: ${typeof value}`,
									cause: value
								})
							}

							const requireDateTimeString = (row: Row, key: string): string => {
								const value = row[key]
								if (typeof value === "string") return value
								if (value instanceof Date) return value.toISOString()
								if (typeof value === "number") return new Date(value).toISOString()
								throw new ElectricSyncError({
									message: `Expected "${key}" to be a datetime string, Date, or epoch ms number`,
									cause: value
								})
							}

							// Group messages by shape
							const actionRecordsMessages: MultiShapeMessages<{
								action_records: Row
							}>[] = []
							const actionModifiedRowsMessages: MultiShapeMessages<{
								action_modified_rows: Row
							}>[] = []
							const allShapesUpToDate = true
							const actions: ActionRecord[] = []
							const modifiedRows: ActionModifiedRow[] = []

							// Process each message and insert into the appropriate table
							for (const message of messages) {
								if (message.shape === "action_records") {
									actionRecordsMessages.push(message)

									// Only insert if it's a change message (not a control message)
									if (isChangeMessage(message) && !isControlMessage(message)) {
										const row = message.value
										const id = requireString(row, "id")
										const tag = requireString(row, "_tag")
										const clientId = requireString(row, "client_id")
										const transactionId = requireNumberFromValue(row, "transaction_id")
										const serverIngestId = optionalNumberFromValue(row, "server_ingest_id")
										const userId = optionalString(row, "user_id")
										const createdAt = requireDateTimeString(row, "created_at")
										const serverIngestedAt = requireDateTimeString(row, "server_ingested_at")
										const clockTimeMs = requireNumberFromValue(row, "clock_time_ms")
										const clockCounter = requireNumberFromValue(row, "clock_counter")
										const synced = requireDbBoolean(row, "synced")

										actions.push({
											id,
											server_ingest_id: serverIngestId,
											_tag: tag,
											user_id: userId,
											client_id: clientId,
											transaction_id: transactionId,
											clock: requireJsonObjectColumn(row, "clock") as ActionRecord["clock"],
											clock_time_ms: clockTimeMs,
											clock_counter: clockCounter,
											args: requireJsonObjectColumn(row, "args") as ActionRecord["args"],
											created_at: new Date(createdAt),
											server_ingested_at: new Date(serverIngestedAt),
											synced: synced === 1
										})
									}
								} else if (isChangeMessage(message) && message.shape === "action_modified_rows") {
									actionModifiedRowsMessages.push(message)

									// Only insert if it's a change message (not a control message)
									if (!isControlMessage(message)) {
										const row = message.value
										const id = requireString(row, "id")
										const tableName = requireString(row, "table_name")
										const rowId = requireString(row, "row_id")
										const actionRecordId = requireString(row, "action_record_id")
										const audienceKey = requireString(row, "audience_key")
										const operation = requireString(row, "operation")
										if (
											operation !== "INSERT" &&
											operation !== "UPDATE" &&
											operation !== "DELETE"
										) {
											throw new ElectricSyncError({
												message: `Expected "operation" to be INSERT|UPDATE|DELETE, got: ${operation}`
											})
										}
										const sequence = requireNumberFromValue(row, "sequence")

										modifiedRows.push({
											id,
											table_name: tableName,
											row_id: rowId,
											action_record_id: actionRecordId,
											audience_key: audienceKey,
											operation: operation as ActionModifiedRow["operation"],
											forward_patches: jsonObjectColumnOrEmpty(
												row,
												"forward_patches"
											) as ActionModifiedRow["forward_patches"],
											reverse_patches: jsonObjectColumnOrEmpty(
												row,
												"reverse_patches"
											) as ActionModifiedRow["reverse_patches"],
											sequence
										})
									}
								}
							}

							yield* ingestRemoteSyncLogBatch(sql, { actions, modifiedRows })

							// Check if we have at least one message for each shape and all are up-to-date
							const hasActionRecords = actionRecordsMessages.length > 0
							const hasActionModifiedRows = actionModifiedRowsMessages.length > 0
							const actionRecordsUpToDate =
								hasActionRecords && actionRecordsMessages.some((msg) => msg.headers.last === true)
							const actionModifiedRowsUpToDate =
								hasActionModifiedRows &&
								actionModifiedRowsMessages.some((msg) => msg.headers.last === true)

							// If all shapes are up-to-date, trigger performSync
							if (allShapesUpToDate && actionRecordsUpToDate && actionModifiedRowsUpToDate) {
								yield* Effect.logInfo(
									"All shapes in multi-stream are synced. Triggering performSync."
								)
								yield* Ref.set(fullySyncedRef, true)
								yield* syncService.performSync()
							}

							return messages
						})
					)
				),
				Stream.catchAllCause((cause) => {
					Effect.runFork(Effect.logError("Error in multi-shape stream", cause))
					return Stream.empty
				}),
				Stream.runDrain,
				Effect.forkScoped
			)

			yield* Effect.logInfo(`ElectricSyncService created`)

			return {
				isFullySynced: () => Ref.get(fullySyncedRef)
			} as const
		})
	}
) {}
