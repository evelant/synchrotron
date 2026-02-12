import { Effect, Schema, Stream } from "effect"
import type { ActionModifiedRow, ActionRecord } from "./models"

export class SyncIngressError extends Schema.TaggedError<SyncIngressError>()("SyncIngressError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Unknown)
}) {}

export type SyncIngressEvent =
	| {
			readonly _tag: "Batch"
			readonly actions: ReadonlyArray<ActionRecord>
			readonly modifiedRows: ReadonlyArray<ActionModifiedRow>
			readonly caughtUp?: boolean | undefined
	  }
	| {
			readonly _tag: "Wakeup"
			readonly caughtUp?: boolean | undefined
	  }

export interface SyncIngressService {
	readonly _tag: "SyncIngress"
	readonly events: Stream.Stream<SyncIngressEvent, SyncIngressError>
}

export const MissingSyncIngress: SyncIngressService = {
	_tag: "SyncIngress",
	events: Stream.empty
}

/**
 * Optional remote ingress event stream for push / notify transports.
 *
 * This service is intentionally minimal:
 * - `Batch` delivers action log rows (to be ingested into local sync tables)
 * - `Wakeup` notifies that a sync run should be attempted (notify-only transports)
 *
 * `sync-core` owns the ingestion (`ingestRemoteSyncLogBatch`) and the sync loop (`SyncService.requestSync()`).
 */
export class SyncIngress extends Effect.Service<SyncIngress>()("SyncIngress", {
	effect: Effect.succeed(MissingSyncIngress)
}) {}
