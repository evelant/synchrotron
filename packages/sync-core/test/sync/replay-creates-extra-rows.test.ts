import type { SqlClient } from "@effect/sql"
import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { CorrectionActionTag } from "@synchrotron/sync-core/SyncActionTags"
import { Effect } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("Replay creates extra/new rows (TODO 0020)", () => {
	it.scoped(
		"emits an additive CORRECTION INSERT for extra rows created only during replay",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const identityByTable = {
					notes: ["user_id", "title"],
					note_admin_meta: ["user_id", "note_id", "kind"],
					test_apply_patches: (row: any) => row
				} as const

				const clientA = yield* createTestClient("clientA", serverSql, { identityByTable })
				const clientB = yield* createTestClient("clientB", serverSql, { identityByTable })
				const clientC = yield* createTestClient("clientC", serverSql, { identityByTable })

				// Shared schema setup (client DBs + server DB) for the extra tracked table.
				const installNoteAdminMeta = (sql: SqlClient.SqlClient) =>
					Effect.gen(function* () {
						yield* sql`
							CREATE TABLE IF NOT EXISTS note_admin_meta (
								id TEXT PRIMARY KEY,
								note_id TEXT NOT NULL,
								kind TEXT NOT NULL,
								user_id TEXT NOT NULL,
								audience_key TEXT GENERATED ALWAYS AS ('user:' || user_id) STORED
							)
						`
					})

				yield* installNoteAdminMeta(serverSql)
				yield* installNoteAdminMeta(clientA.rawSql)
				yield* installNoteAdminMeta(clientB.rawSql)
				yield* installNoteAdminMeta(clientC.rawSql)

				yield* clientA.clientDbAdapter.installPatchCapture(["note_admin_meta"])
				yield* clientB.clientDbAdapter.installPatchCapture(["note_admin_meta"])
				yield* clientC.clientDbAdapter.installPatchCapture(["note_admin_meta"])

				const { result } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteWithExtraRowOnClientBAction({
						title: "Extra Row Test",
						content: "Base Content",
						user_id: "user1"
					})
				)

				yield* clientA.syncService.performSync()

				// Client B replays the action and creates an additional row that wasn't in the original patch set.
				yield* clientB.syncService.performSync()

				const correctionActionsB = yield* clientB.actionRecordRepo.findByTag(CorrectionActionTag)
				expect(correctionActionsB.length).toBe(1)
				const correctionActionB = correctionActionsB[0]
				expect(correctionActionB?.synced).toBe(true)
				if (!correctionActionB) return

				const correctionAmrsB = yield* clientB.actionModifiedRowRepo.findByActionRecordIds([
					correctionActionB.id
				])
				expect(
					correctionAmrsB.some(
						(amr) =>
							amr.table_name === "note_admin_meta" &&
							amr.operation === "INSERT" &&
							typeof amr.row_id === "string" &&
							amr.row_id.length > 0
					)
				).toBe(true)

				// Client C does NOT generate the extra row via replay, but should receive it via CORRECTION.
				yield* clientC.syncService.performSync()

				const [metaCountC] = yield* clientC.rawSql<{ readonly count: number }>`
					SELECT count(*)::int AS count FROM note_admin_meta
				`
				expect(metaCountC?.count).toBe(1)

				// Server materialization should also include the additive row.
				const [metaCountServer] = yield* serverSql<{ readonly count: number }>`
					SELECT count(*)::int AS count FROM note_admin_meta
				`
				expect(metaCountServer?.count).toBe(1)

				// Sanity: the base action result id is stable and referenced (not required for this test).
				expect(result.noteId).toBeDefined()
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
