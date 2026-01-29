import type { SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ClientClockState } from "../ClientClockState"

export class SyncDoctorCorruption extends Schema.TaggedError<SyncDoctorCorruption>()(
	"SyncDoctorCorruption",
	{
		message: Schema.String,
		lastSeenServerIngestId: Schema.Number,
		firstUnappliedActionId: Schema.optional(Schema.String),
		firstUnappliedServerIngestId: Schema.optional(Schema.Number)
	}
) {}

const parseDbBoolean = (value: unknown) => (value === true || value === 1 ? true : false)

const normalizeSqlNumber = (value: number | string | bigint | null | undefined) => {
	if (value === null || value === undefined) return 0
	if (typeof value === "number") return value
	if (typeof value === "bigint") return Number(value)
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

export const runSyncDoctor = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly clockState: ClientClockState
	readonly actionRecordRepo: ActionRecordRepo
	readonly clientId: string
	readonly syncSessionId: string
	readonly advanceAppliedRemoteServerIngestCursor: () => Effect.Effect<void, unknown, never>
}) =>
	Effect.gen(function* () {
		const {
			sqlClient,
			clockState,
			actionRecordRepo,
			clientId,
			syncSessionId,
			advanceAppliedRemoteServerIngestCursor
		} = deps

		const [hasAppliedOrphansRow] = yield* sqlClient<{
			readonly has_orphans: boolean | 0 | 1
		}>`
			SELECT EXISTS (
				SELECT 1
				FROM local_applied_action_ids la
				LEFT JOIN action_records ar ON ar.id = la.action_record_id
				WHERE ar.id IS NULL
				LIMIT 1
			) AS has_orphans
		`
		const hasAppliedOrphans = parseDbBoolean(hasAppliedOrphansRow?.has_orphans)

		if (hasAppliedOrphans) {
			const [countRow] = yield* sqlClient<{
				readonly orphan_count: number | string | bigint | null
			}>`
				SELECT COUNT(*) AS orphan_count
				FROM local_applied_action_ids la
				LEFT JOIN action_records ar ON ar.id = la.action_record_id
				WHERE ar.id IS NULL
			`
			const orphanCount = normalizeSqlNumber(countRow?.orphan_count)
			yield* Effect.logWarning("performSync.syncDoctor.orphanAppliedIds", {
				syncSessionId,
				orphanCount
			})
			yield* sqlClient`
				DELETE FROM local_applied_action_ids
				WHERE action_record_id NOT IN (SELECT id FROM action_records)
			`.pipe(Effect.asVoid)
		}

		const [hasAmrOrphansRow] = yield* sqlClient<{
			readonly has_orphans: boolean | 0 | 1
		}>`
			SELECT EXISTS (
				SELECT 1
				FROM action_modified_rows amr
				LEFT JOIN action_records ar ON ar.id = amr.action_record_id
				WHERE ar.id IS NULL
				LIMIT 1
			) AS has_orphans
		`
		const hasAmrOrphans = parseDbBoolean(hasAmrOrphansRow?.has_orphans)

		if (hasAmrOrphans) {
			const [countRow] = yield* sqlClient<{
				readonly orphan_count: number | string | bigint | null
			}>`
				SELECT COUNT(*) AS orphan_count
				FROM action_modified_rows amr
				LEFT JOIN action_records ar ON ar.id = amr.action_record_id
				WHERE ar.id IS NULL
			`
			const orphanCount = normalizeSqlNumber(countRow?.orphan_count)
			yield* Effect.logWarning("performSync.syncDoctor.orphanAmrs", { syncSessionId, orphanCount })
			yield* sqlClient`
				DELETE FROM action_modified_rows
				WHERE action_record_id NOT IN (SELECT id FROM action_records)
			`.pipe(Effect.asVoid)
		}

		const [hasQuarantineOrphansRow] = yield* sqlClient<{
			readonly has_orphans: boolean | 0 | 1
		}>`
			SELECT EXISTS (
				SELECT 1
				FROM local_quarantined_actions q
				LEFT JOIN action_records ar ON ar.id = q.action_record_id
				WHERE ar.id IS NULL
				LIMIT 1
			) AS has_orphans
		`
		const hasQuarantineOrphans = parseDbBoolean(hasQuarantineOrphansRow?.has_orphans)

		if (hasQuarantineOrphans) {
			const [countRow] = yield* sqlClient<{
				readonly orphan_count: number | string | bigint | null
			}>`
				SELECT COUNT(*) AS orphan_count
				FROM local_quarantined_actions q
				LEFT JOIN action_records ar ON ar.id = q.action_record_id
				WHERE ar.id IS NULL
			`
			const orphanCount = normalizeSqlNumber(countRow?.orphan_count)
			yield* Effect.logWarning("performSync.syncDoctor.orphanQuarantineRows", {
				syncSessionId,
				orphanCount
			})
			yield* sqlClient`
				DELETE FROM local_quarantined_actions
				WHERE action_record_id NOT IN (SELECT id FROM action_records)
			`.pipe(Effect.asVoid)
		}

		const lastSeenBefore = yield* clockState.getLastSeenServerIngestId
		yield* advanceAppliedRemoteServerIngestCursor()
		const lastSeenAfter = yield* clockState.getLastSeenServerIngestId
		if (lastSeenAfter !== lastSeenBefore) {
			yield* Effect.logDebug("performSync.syncDoctor.advanceAppliedCursor", {
				syncSessionId,
				lastSeenBefore,
				lastSeenAfter
			})
		}

		const [unappliedAtOrBeforeCursor] = yield* sqlClient<{
			readonly id: string
			readonly server_ingest_id: number | string | bigint | null
		}>`
			SELECT ar.id, ar.server_ingest_id
			FROM action_records ar
			LEFT JOIN local_applied_action_ids la ON la.action_record_id = ar.id
			WHERE la.action_record_id IS NULL
			AND ar.synced = 1
			AND ar.client_id != ${clientId}
			AND ar.server_ingest_id IS NOT NULL
			AND ar.server_ingest_id <= ${lastSeenAfter}
			ORDER BY ar.server_ingest_id ASC, ar.id ASC
			LIMIT 1
		`
		if (unappliedAtOrBeforeCursor) {
			const badId = unappliedAtOrBeforeCursor.id
			const badIngestId = normalizeSqlNumber(unappliedAtOrBeforeCursor.server_ingest_id)
			const pending = yield* actionRecordRepo.allUnsyncedActive()
			return yield* Effect.fail(
				new SyncDoctorCorruption({
					message:
						"Remote action is synced-but-unapplied at or before the client cursor; local sync state is inconsistent",
					lastSeenServerIngestId: lastSeenAfter,
					firstUnappliedActionId: badId,
					firstUnappliedServerIngestId: badIngestId
				})
			).pipe(
				Effect.tapError(() =>
					Effect.logError("performSync.syncDoctor.corruption", {
						syncSessionId,
						lastSeenServerIngestId: lastSeenAfter,
						firstUnappliedActionId: badId,
						firstUnappliedServerIngestId: badIngestId,
						pendingCount: pending.length
					})
				)
			)
		}
	}).pipe(
		Effect.annotateLogs({
			clientId: deps.clientId,
			syncSessionId: deps.syncSessionId,
			operation: "syncDoctor"
		}),
		Effect.withSpan("SyncService.syncDoctor", {
			attributes: { clientId: deps.clientId, syncSessionId: deps.syncSessionId }
		}),
		deps.sqlClient.withTransaction
	)
