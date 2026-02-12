import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option, Stream } from "effect"
import { ClientDbAdapter } from "./ClientDbAdapter"
import { SyncIngress, type SyncIngressEvent } from "./SyncIngress"
import { ingestRemoteSyncLogBatch } from "./SyncLogIngest"
import { SyncService } from "./SyncService"

export const runSyncIngressRunner = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const clientDbAdapter = yield* ClientDbAdapter
	const syncService = yield* SyncService

	const ingressOption = yield* Effect.serviceOption(SyncIngress)
	if (Option.isNone(ingressOption)) return
	const ingress = ingressOption.value

	// Ensure sync tables/functions exist before any remote ingestion runs.
	yield* clientDbAdapter.initializeSyncSchema

	const handleEvent = (event: SyncIngressEvent) =>
		Effect.gen(function* () {
			switch (event._tag) {
				case "Batch": {
					yield* ingestRemoteSyncLogBatch(sql, {
						actions: event.actions,
						modifiedRows: event.modifiedRows
					})
					// Some push transports may want to avoid triggering sync while still catching up.
					// By default we do trigger; setting `caughtUp: false` opts out.
					if (event.caughtUp !== false) {
						yield* syncService.requestSync()
					}
					return
				}
				case "Wakeup": {
					yield* syncService.requestSync()
					return
				}
			}
		})

	yield* ingress.events.pipe(
		Stream.mapEffect(handleEvent),
		Stream.catchAllCause((cause) =>
			Stream.fromEffect(Effect.logError("sync.ingress.runner.error", cause)).pipe(
				Stream.zipRight(Stream.empty)
			)
		),
		Stream.runDrain,
		Effect.forkScoped
	)
})

/**
 * Core-owned ingress runner.
 *
 * Responsibilities:
 * - consume `SyncIngress.events`
 * - persist remote batches into local sync tables (idempotent)
 * - trigger `SyncService.requestSync()` in a coalesced, single-flight-safe way
 */
export const SyncIngressRunnerLive = Layer.scopedDiscard(runSyncIngressRunner)
