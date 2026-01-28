/**
 * Electric ingress service.
 *
 * Subscribes to Electric Shape streams for the sync tables (`action_records`, `action_modified_rows`)
 * and ingests delivered rows into the local DB using the core-owned ingestion helper
 * (`ingestRemoteSyncLogBatch`).
 *
 * This service is intentionally ingress-only:
 * - it does not execute action logic itself
 * - it relies on `SyncService.performSync()` to apply/reconcile once remote rows are ingested
 * - RPC fetch is still used for metadata (epoch/retention) in Electric mode
 */
import { SqlClient } from "@effect/sql"
import type { Row } from "@electric-sql/client"

import { TransactionalMultiShapeStream, type MultiShapeMessages } from "@electric-sql/experimental"
import { SyncService, ingestRemoteSyncLogBatch } from "@synchrotron/sync-core"
import { Effect, Ref, Stream } from "effect"
import { SynchrotronClientConfig } from "../config"
import { decodeElectricMultiShapeBatch } from "./ElectricSyncDecode"
import { ElectricSyncError } from "./ElectricSyncError"

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

			const errorMessage = (error: unknown): string =>
				error instanceof Error ? error.message : String(error)

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
						message: `Failed to create TransactionalMultiShapeStream: ${errorMessage(e)}`,
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
											message: `MultiShapeStream error: ${errorMessage(error)}`,
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
							const decoded = yield* Effect.try({
								try: () => decodeElectricMultiShapeBatch(messages),
								catch: (e) =>
									e instanceof ElectricSyncError
										? e
										: new ElectricSyncError({
												message: `Failed to decode Electric multi-shape batch: ${errorMessage(e)}`,
												cause: e
											})
							})

							yield* ingestRemoteSyncLogBatch(sql, {
								actions: decoded.actions,
								modifiedRows: decoded.modifiedRows
							})

							// If all shapes are up-to-date, trigger performSync.
							// (Currently all shapes are always considered up-to-date once each emits `headers.last`.)
							const allShapesUpToDate = true
							if (
								allShapesUpToDate &&
								decoded.actionRecordsUpToDate &&
								decoded.actionModifiedRowsUpToDate
							) {
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
