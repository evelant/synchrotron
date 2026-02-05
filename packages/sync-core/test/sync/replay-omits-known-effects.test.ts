import type { SqlClient } from "@effect/sql"
import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { CorrectionActionTag } from "@synchrotron/sync-core/SyncActionTags"
import { Effect } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("Replay omits known row effects (TODO 0020)", () => {
	it.scoped(
		"patch-applies known INSERTs when replay omits them (subtractive divergence)",
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

				yield* clientA.clientDbAdapter.installPatchCapture(["note_admin_meta"])
				yield* clientB.clientDbAdapter.installPatchCapture(["note_admin_meta"])

				const { result } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteWithExtraRowOnClientAAction({
						title: "Subtractive Divergence",
						content: "Base Content",
						user_id: "user1"
					})
				)
				expect(result.metaId).toBeDefined()

				yield* clientA.syncService.performSync()
				yield* clientB.syncService.performSync()

				// Client B replay omits the meta row, but it should still be materialized from known patches.
				const [metaCountB] = yield* clientB.rawSql<{ readonly count: number }>`
					SELECT count(*)::int AS count FROM note_admin_meta
				`
				expect(metaCountB?.count).toBe(1)

				const metaRowsB = yield* clientB.rawSql<{ readonly id: string; readonly kind: string }>`
					SELECT id, kind
					FROM note_admin_meta
				`
				expect(metaRowsB[0]?.id).toBe(result.metaId)
				expect(metaRowsB[0]?.kind).toBe("origin-only")

				// Subtractive divergence should not emit an outgoing CORRECTION (delta is only generated - known).
				const correctionActionsB = yield* clientB.actionRecordRepo.findByTag(CorrectionActionTag)
				expect(correctionActionsB.length).toBe(0)

				const [metaCountServer] = yield* serverSql<{ readonly count: number }>`
					SELECT count(*)::int AS count FROM note_admin_meta
				`
				expect(metaCountServer?.count).toBe(1)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
