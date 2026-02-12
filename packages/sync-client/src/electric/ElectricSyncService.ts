/**
 * Electric ingress service.
 *
 * Subscribes to Electric Shape streams for the sync tables (`action_records`, `action_modified_rows`)
 * and emits `SyncIngress` events for a core-owned runner to ingest/apply.
 *
 * This service is intentionally ingress-only:
 * - it does not execute action logic itself
 * - it does not write to the DB directly (core-owned runner does ingestion)
 * - RPC fetch is still used for metadata (epoch/retention) in Electric mode
 */
import type { Row } from "@electric-sql/client"

import { TransactionalMultiShapeStream, type MultiShapeMessages } from "@electric-sql/experimental"
import { SyncIngress, SyncIngressError, type SyncIngressEvent } from "@synchrotron/sync-core"
import { Effect, Layer, Ref, Stream } from "effect"
import { SynchrotronClientConfig } from "../config"
import { decodeElectricMultiShapeBatch } from "./ElectricSyncDecode"
import { ElectricSyncError } from "./ElectricSyncError"

type ElectricSyncShapes = {
	action_records: Row
	action_modified_rows: Row
}

type ElectricMultiShapeBatch = ReadonlyArray<MultiShapeMessages<ElectricSyncShapes>>

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error)

const toIngressError = (message: string, cause: unknown) =>
	new SyncIngressError({
		message,
		cause
	})

const makeTransactionalMultiShapeStream = (electricUrl: string) =>
	Effect.tryPromise({
		try: async () =>
			new TransactionalMultiShapeStream<ElectricSyncShapes>({
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
			}),
		catch: (e) =>
			new ElectricSyncError({
				message: `Failed to create TransactionalMultiShapeStream: ${errorMessage(e)}`,
				cause: e
			})
	})

const makeMultiShapeMessagesStream = (
	multiShapeStream: TransactionalMultiShapeStream<ElectricSyncShapes>
) =>
	Stream.asyncScoped<ElectricMultiShapeBatch, SyncIngressError>((emit) =>
		Effect.logInfo("Subscribing to TransactionalMultiShapeStream").pipe(
			Effect.zipRight(
				Effect.acquireRelease(
					Effect.sync(() =>
						multiShapeStream.subscribe(
							(messages) => {
								emit.single(messages)
							},
							(error: unknown) => {
								emit.fail(
									toIngressError(`Electric multi-shape stream error: ${errorMessage(error)}`, error)
								)
							}
						)
					),
					(unsubscribe) =>
						Effect.logInfo("Unsubscribing from TransactionalMultiShapeStream").pipe(
							Effect.zipRight(Effect.sync(() => unsubscribe()))
						)
				).pipe(Effect.asVoid)
			)
		)
	)

export class ElectricSyncService extends Effect.Service<ElectricSyncService>()(
	"ElectricSyncService",
	{
		scoped: Effect.gen(function* () {
			yield* Effect.logInfo(`creating ElectricSyncService`)
			const config = yield* SynchrotronClientConfig
			const fullySyncedRef = yield* Ref.make(false)
			const electricUrl = config.electricSyncUrl
			yield* Effect.logInfo(`Creating TransactionalMultiShapeStream`)

			const multiShapeStream = yield* makeTransactionalMultiShapeStream(electricUrl)
			const multiShapeMessagesStream = makeMultiShapeMessagesStream(multiShapeStream)

			yield* Effect.logInfo(`ElectricSyncService created`)

			const decodeMessages = (messages: ElectricMultiShapeBatch) =>
				Effect.try({
					try: () => decodeElectricMultiShapeBatch(messages),
					catch: (e) =>
						e instanceof ElectricSyncError
							? toIngressError(`Failed to decode Electric multi-shape batch: ${e.message}`, e.cause)
							: toIngressError(`Failed to decode Electric multi-shape batch: ${errorMessage(e)}`, e)
				})

			const toEvents = (messages: ElectricMultiShapeBatch) =>
				decodeMessages(messages).pipe(
					Effect.map((decoded) => {
						const caughtUp = decoded.actionRecordsUpToDate && decoded.actionModifiedRowsUpToDate
						return { decoded, caughtUp } as const
					}),
					Effect.tap(({ caughtUp }) => (caughtUp ? Ref.set(fullySyncedRef, true) : Effect.void)),
					Effect.map(({ decoded, caughtUp }): ReadonlyArray<SyncIngressEvent> => {
						if (decoded.actions.length === 0 && decoded.modifiedRows.length === 0) {
							// Still emit a wakeup when transitioning to "caught up" so the sync loop can
							// run at least once (uploads + apply from DB are both DB-driven).
							return caughtUp ? [{ _tag: "Wakeup", caughtUp: true }] : []
						}

						return [
							{
								_tag: "Batch",
								actions: decoded.actions,
								modifiedRows: decoded.modifiedRows,
								// Explicitly opt out of triggering sync until Electric reports both shapes
								// up-to-date; this avoids churn while the initial backfill is in-flight.
								caughtUp: caughtUp ? true : false
							}
						]
					})
				)

			const events = multiShapeMessagesStream.pipe(
				Stream.mapEffect(toEvents),
				Stream.flatMap((chunk) => Stream.fromIterable(chunk))
			)

			return {
				events,
				isFullySynced: () => Ref.get(fullySyncedRef)
			} as const
		})
	}
) {}

export const ElectricSyncIngressLive = Layer.effect(
	SyncIngress,
	Effect.map(ElectricSyncService, (electric) =>
		SyncIngress.of({
			_tag: "SyncIngress",
			events: electric.events
		})
	)
)
