import { ShapeStream } from "@electric-sql/client"
import { ClockService } from "@synchrotron/sync-core/ClockService"
import { Effect, Schema } from "effect"
import { PgLiteSyncTag } from "../db/connection"

export class ElectricSyncError extends Schema.TaggedError<ElectricSyncError>()(
	"ElectricSyncError",
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown)
	}
) {}

export interface ElectricShape {
	unsubscribe: () => void
	isUpToDate: boolean
	subscribe: (callback: () => void, errorCallback: (error: unknown) => void) => void
	stream: ShapeStream
}

export class ElectricSyncService extends Effect.Service<ElectricSyncService>()(
	"ElectricSyncService",
	{
		scoped: Effect.gen(function* () {
			yield* Effect.logInfo(`creating ElectricSyncService`)
			const clockService = yield* ClockService
			const clientId = yield* clockService.getNodeId
			const pgLiteClient = yield* PgLiteSyncTag
			// Track active shape subscriptions
			const activeShapes: Record<string, { unsubscribe: () => void; isUpToDate: boolean }> = {}

			const createShape = Effect.gen(function* () {})

			const syncActionRecords = (baseUrl: string) =>
				Effect.gen(function* () {
					// Get the last synced clock to use in the where clause
					const lastSyncedClock = yield* clockService.getLastSyncedClock

					yield* Effect.logInfo(
						`Setting up action_records sync with Electric using last synced clock: ${JSON.stringify(lastSyncedClock)}`
					)

					const actionRecordsStream = {
						url: `${baseUrl}/v1/shape`,
						params: {
							table: "action_records"

							// where: `clock > '${JSON.stringify(lastSyncedClock)}'::jsonb`
						}
					}

					const columnMapping = {
						id: "id",
						_tag: "_tag",
						client_id: "client_id",
						transaction_id: "transaction_id",
						clock: "clock",
						args: "args",
						created_at: "created_at",
						synced: "synced",
						sortable_clock: "sortable_clock"
					}

					// Using the PGlite electric sync module to sync the shape to our table
					const createShapeEffect = Effect.tryPromise({
						try: () =>
							pgLiteClient.extensions.electric.syncShapeToTable({
								shape: actionRecordsStream,
								table: "action_records",
								schema: "public",
								mapColumns: columnMapping,
								primaryKey: ["id"],
								shapeKey: "action_records_sync",
								useCopy: true,
								onInitialSync: () => {
									console.log("Initial action_records sync complete")
								}
							}),
						catch: (error: unknown) =>
							new ElectricSyncError({
								message: `Failed to sync action_records: ${error instanceof Error ? error.message : String(error)}`,
								cause: error
							})
					})

					// Using acquireRelease for proper resource management
					const actionRecordsShape = yield* Effect.acquireRelease(createShapeEffect, (shape) =>
						Effect.sync(() => {
							// Release function to clean up the subscription
							if (shape.unsubscribe) {
								shape.unsubscribe()
							}
							// Remove from active shapes
							delete activeShapes["action_records"]
						})
					)

					// Register the shape subscription for tracking
					activeShapes["action_records"] = {
						unsubscribe: actionRecordsShape.unsubscribe || (() => {}),
						isUpToDate: Boolean(actionRecordsShape.isUpToDate)
					}

					// Set up a subscription to track when the shape is up to date
					actionRecordsShape.stream.subscribe(
						() => {
							console.log("Action records sync is up to date")
							if (activeShapes["action_records"]) {
								activeShapes["action_records"].isUpToDate = true
							}
						},
						(error) => {
							console.error("Action records sync error:", error)
						}
					)

					yield* Effect.logInfo("Action records sync setup complete")
					return actionRecordsShape
				}).pipe(
					Effect.catchTag("ElectricSyncError", (error) => Effect.fail(error)),
					Effect.catchAll((error) => {
						const message = error instanceof Error ? error.message : String(error)
						return Effect.fail(new ElectricSyncError({ message }))
					}),
					Effect.withSpan("electric.syncActionRecords")
				)

			const syncActionModifiedRows = (baseUrl: string) =>
				Effect.gen(function* () {
					// Get the last synced clock to use in the where clause
					const lastSyncedClock = yield* clockService.getLastSyncedClock

					yield* Effect.logInfo(
						`Setting up action_modified_rows sync with Electric using last synced clock: ${JSON.stringify(lastSyncedClock)}`
					)

					const amrStream = {
						url: `${baseUrl}/v1/shape`,
						params: {
							table: "action_modified_rows"

							// where: `action_record_id IN (SELECT id FROM action_records WHERE clock > '${JSON.stringify(lastSyncedClock)}'::jsonb)`
						}
					}

					const columnMapping = {
						id: "id",
						table_name: "table_name",
						row_id: "row_id",
						action_record_id: "action_record_id",
						operation: "operation",
						forward_patches: "forward_patches",
						reverse_patches: "reverse_patches",
						sequence: "sequence"
					}

					// Using the PGlite electric sync module to sync the shape to our table
					const createShapeEffect = Effect.tryPromise({
						try: () =>
							pgLiteClient.extensions.electric.syncShapeToTable({
								shape: amrStream,
								table: "action_modified_rows",
								schema: "public",
								mapColumns: columnMapping,
								primaryKey: ["id"],
								shapeKey: "action_modified_rows_sync",
								useCopy: true,
								onInitialSync: () => {
									console.log("Initial action_modified_rows sync complete")
								}
							}),
						catch: (error: unknown) =>
							new ElectricSyncError({
								message: `Failed to sync action_modified_rows: ${error instanceof Error ? error.message : String(error)}`,
								cause: error
							})
					})

					// Using acquireRelease for proper resource management
					const managedShape = Effect.acquireRelease(createShapeEffect, (shape) =>
						Effect.sync(() => {
							// Release function to clean up the subscription
							if (shape.unsubscribe) {
								shape.unsubscribe()
							}
							// Remove from active shapes
							delete activeShapes["action_modified_rows"]
						})
					)

					// Get the shape and set up tracking
					const amrShape = yield* managedShape

					// Register the shape subscription for tracking
					activeShapes["action_modified_rows"] = {
						unsubscribe: amrShape.unsubscribe || (() => {}),
						isUpToDate: Boolean(amrShape.isUpToDate)
					}

					// Set up a subscription to track when the shape is up to date
					amrShape.stream.subscribe(
						() => {
							console.log("Action modified rows sync is up to date")
							if (activeShapes["action_modified_rows"]) {
								activeShapes["action_modified_rows"].isUpToDate = true
							}
						},
						(error) => {
							console.error("Action modified rows sync error:", error)
						}
					)

					yield* Effect.logInfo("Action modified rows sync setup complete")
					return amrShape
				}).pipe(
					Effect.catchTag("ElectricSyncError", (error) => Effect.fail(error)),
					Effect.catchAll((error) => {
						const message = error instanceof Error ? error.message : String(error)
						return Effect.fail(new ElectricSyncError({ message }))
					}),
					Effect.withSpan("electric.syncActionModifiedRows")
				)

			const setupSync = (baseUrl: string) =>
				Effect.gen(function* () {
					yield* Effect.logInfo(`Setting up Electric sync with base URL: ${baseUrl}`)

					const [actionRecordsShape, amrShape] = yield* Effect.all([
						syncActionRecords(baseUrl),
						syncActionModifiedRows(baseUrl)
					])

					return { actionRecordsShape, amrShape }
				}).pipe(
					Effect.catchTag("ElectricSyncError", (error) => Effect.fail(error)),
					Effect.withSpan("electric.setupSync")
				)

			const cleanup = () =>
				Effect.gen(function* () {
					const shapeEntries = Object.entries(activeShapes)

					if (shapeEntries.length === 0) {
						return true
					}

					for (const [key, { unsubscribe }] of shapeEntries) {
						yield* Effect.sync(() => {
							unsubscribe()
							delete activeShapes[key]
						})
					}

					yield* Effect.logInfo("Cleaned up all shape subscriptions")
					return true
				})

			const isFullySynced = () =>
				Effect.sync(() => {
					const shapes = Object.values(activeShapes)
					if (shapes.length === 0) return false
					return shapes.every(({ isUpToDate }) => isUpToDate)
				})

			return {
				setupSync,
				syncActionRecords,
				syncActionModifiedRows,
				cleanup,
				isFullySynced
			}
		})
	}
) {}
