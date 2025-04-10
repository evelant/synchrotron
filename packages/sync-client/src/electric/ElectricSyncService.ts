import { PgLiteClient } from "@effect/sql-pglite"
import type { Row } from "@electric-sql/client"

import { isChangeMessage, isControlMessage } from "@electric-sql/client"
import { TransactionalMultiShapeStream, type MultiShapeMessages } from "@electric-sql/experimental"
import {
	SyncService,
	type ActionModifiedRowJson,
	type ActionRecordJson
} from "@synchrotron/sync-core"
import { ClockService } from "@synchrotron/sync-core/ClockService"
import { SynchrotronClientConfig } from "@synchrotron/sync-core/config"
import { Effect, Schema, Stream } from "effect"

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
			const clockService = yield* ClockService
			const syncService = yield* SyncService
			const config = yield* SynchrotronClientConfig
			const sql = yield* PgLiteClient.PgLiteClient
			const electricUrl = config.electricSyncUrl
			yield* Effect.logInfo(`Creating TransactionalMultiShapeStream`)

			const multiShapeStream = yield* Effect.tryPromise({
				try: async () => {
					return new TransactionalMultiShapeStream<{
						action_records: Row<ActionRecordJson>
						action_modified_rows: Row<ActionModifiedRowJson>
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
					action_records: Row<ActionRecordJson>
					action_modified_rows: Row<ActionModifiedRowJson>
				}>[],
				ElectricSyncError
			>((emit) =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Subscribing to TransactionalMultiShapeStream")
					return yield* Effect.acquireRelease(
						Effect.gen(function* () {
							return multiShapeStream.subscribe(
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
						}),
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
							// Group messages by shape
							const actionRecordsMessages: MultiShapeMessages<{
								action_records: Row<ActionRecordJson>
							}>[] = []
							const actionModifiedRowsMessages: MultiShapeMessages<{
								action_modified_rows: Row<ActionModifiedRowJson>
							}>[] = []
							let allShapesUpToDate = true

							// Process each message and insert into the appropriate table
							for (const message of messages) {
								if (message.shape === "action_records") {
									actionRecordsMessages.push(message)

									// Only insert if it's a change message (not a control message)
									if (!isControlMessage(message)) {
										// Insert with ON CONFLICT DO NOTHING
										// Cast to any to work around type issues with ChangeMessage
										const row = message.value
										yield* Effect.flatMap(
											sql`
												INSERT INTO action_records ${sql.insert(row as any)} ON CONFLICT (id) DO NOTHING
											`,
											() => Effect.succeed(undefined)
										)
									}
								} else if (isChangeMessage(message) && message.shape === "action_modified_rows") {
									actionModifiedRowsMessages.push(message)

									// Only insert if it's a change message (not a control message)
									if (!isControlMessage(message)) {
										// Insert with ON CONFLICT DO NOTHING
										// Cast to any to work around type issues with ChangeMessage
										const row = message.value
										yield* Effect.flatMap(
											sql`
												INSERT INTO action_modified_rows ${sql.insert(row as any)} ON CONFLICT (id) DO NOTHING
											`,
											() => Effect.succeed(undefined)
										)
									}
								}
							}

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

			return {}
		})
	}
) {}
