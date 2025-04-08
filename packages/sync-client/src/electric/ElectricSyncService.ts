import type { Message, Row } from "@electric-sql/client" // Import ShapeStreamOptions
// Removed unused import: SyncShapeToTableResult
import { ActionModifiedRow, ActionRecord, SyncService } from "@synchrotron/sync-core" // Added ActionModifiedRow, ActionRecord
import { ClockService } from "@synchrotron/sync-core/ClockService"
import { SynchrotronClientConfig } from "@synchrotron/sync-core/config"
import { Effect, Schema, Stream } from "effect" // Added Cause
import { PgLiteSyncTag } from "../db/connection"

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
			const pgLiteClient = yield* PgLiteSyncTag
			const electricUrl = config.electricSyncUrl
			yield* Effect.logInfo(`Creating TransactionalMultiShapeStream`)

			const multiShapeSync = yield* Effect.tryPromise({
				try: async () => {
					return pgLiteClient.extensions.electric.syncShapesToTables({
						key: "synchrotron-sync",
						shapes: {
							action_records: {
								shape: {
									url: `${electricUrl}/v1/shape`,
									params: { table: "action_records" }
								},

								table: "action_records",
								primaryKey: ["id"]
							},
							action_modified_rows: {
								shape: {
									url: `${electricUrl}/v1/shape`,
									params: { table: "action_modified_rows" }
								},
								table: "action_modified_rows",
								primaryKey: ["id"]
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
			const actionRecordStream = Stream.asyncScoped<
				Message<Row<ActionRecord>>[],
				ElectricSyncError
			>((emit) =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Subscribing to actionRecordStream")
					return yield* Effect.acquireRelease(
						Effect.gen(function* () {
							return multiShapeSync.streams.action_records!.subscribe(
								(messages: any) => {
									emit.single(messages as Message<Row<ActionRecord>>[])
								},
								(error: unknown) => {
									emit.fail(
										new ElectricSyncError({
											message: `actionRecordStream error: ${error instanceof Error ? error.message : String(error)}`,
											cause: error
										})
									)
								}
							)
						}),
						(unsub) =>
							Effect.gen(function* () {
								yield* Effect.logInfo("Unsubscribing from actionRecordStream")
								unsub()
							})
					)
				})
			)
			const actionModifiedRowsStream = Stream.asyncScoped<
				Message<Row<ActionModifiedRow>>[],
				ElectricSyncError
			>((emit) =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Subscribing to actionModifiedRowsStream")
					return yield* Effect.acquireRelease(
						Effect.gen(function* () {
							yield* Effect.logInfo("Subscribing to actionModifiedRowsStream")
							return multiShapeSync.streams.action_modified_rows!.subscribe(
								(messages: any) => {
									emit.single(messages as Message<Row<ActionModifiedRow>>[])
								},
								(error: unknown) => {
									emit.fail(
										new ElectricSyncError({
											message: `actionModifiedRowsStream error: ${error instanceof Error ? error.message : String(error)}`,
											cause: error
										})
									)
								}
							)
						}),
						(unsub) =>
							Effect.gen(function* () {
								yield* Effect.logInfo("Unsubscribing from actionModifiedRowsStream")
								unsub()
							})
					)
				})
			)

			yield* actionRecordStream.pipe(
				Stream.zipLatest(actionModifiedRowsStream),

				Stream.tap((messages) =>
					Effect.logTrace(
						`Multi-shape sync batch received: ${JSON.stringify(messages, (_, v) => (typeof v === "bigint" ? `BIGINT: ${v.toString()}` : v), 2)}`
					)
				),
				Stream.filter(
					([ar, amr]) =>
						ar.every((a) => a.headers.control === "up-to-date") &&
						amr.every((a) => a.headers.control === "up-to-date")
				),
				Stream.tap((_) =>
					Effect.logInfo("All shapes in multi-stream are synced. Triggering performSync.")
				),
				Stream.tap(() => syncService.performSync()),
				Stream.catchAllCause((cause) => {
					Effect.runFork(Effect.logError("Error in combined sync trigger stream", cause))
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
