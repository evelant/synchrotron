import type { SqlClient } from "@effect/sql"
import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { CorrectionActionTag } from "@synchrotron/sync-core/SyncActionTags"
import { Effect } from "effect"
import { makeSqliteTestServerLayer, withSqliteTestClients } from "../helpers/SqliteTestLayers"

describe("Replay creates extra/new rows (SQLite clients) (TODO 0020)", () => {
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

				yield* withSqliteTestClients(
					["clientA", "clientB", "clientC"],
					serverSql,
					{ identityByTable },
					(clients) =>
						Effect.gen(function* () {
							const clientA = clients[0]!
							const clientB = clients[1]!
							const clientC = clients[2]!

							const createNoteAdminMetaTable = (sql: SqlClient.SqlClient) =>
								Effect.gen(function* () {
									yield* sql`
										CREATE TABLE IF NOT EXISTS note_admin_meta (
											id TEXT PRIMARY KEY,
											note_id TEXT NOT NULL,
											kind TEXT NOT NULL,
											user_id TEXT NOT NULL,
											audience_key TEXT GENERATED ALWAYS AS ('user:' || user_id) STORED
										)
									`.raw
								})

							yield* createNoteAdminMetaTable(serverSql)
							yield* createNoteAdminMetaTable(clientA.sql)
							yield* createNoteAdminMetaTable(clientB.sql)
							yield* createNoteAdminMetaTable(clientC.sql)

							yield* clientA.clientDbAdapter.installPatchCapture(["note_admin_meta"])
							yield* clientB.clientDbAdapter.installPatchCapture(["note_admin_meta"])
							yield* clientC.clientDbAdapter.installPatchCapture(["note_admin_meta"])

							yield* clientA.syncService.executeAction(
								clientA.testHelpers.createNoteWithExtraRowOnClientBAction({
									title: "Extra Row Test",
									content: "Base Content",
									user_id: "user1"
								})
							)

							yield* clientA.syncService.performSync()
							yield* clientB.syncService.performSync()

							const correctionActionsB =
								yield* clientB.actionRecordRepo.findByTag(CorrectionActionTag)
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

							yield* clientC.syncService.performSync()

							const [metaCountC] = yield* clientC.sql<{ readonly count: number }>`
								SELECT count(*) AS count FROM note_admin_meta
							`
							expect(metaCountC?.count).toBe(1)

							const [metaCountServer] = yield* serverSql<{ readonly count: number }>`
								SELECT count(*)::int AS count FROM note_admin_meta
							`
							expect(metaCountServer?.count).toBe(1)
						})
				)
			}).pipe(Effect.provide(makeSqliteTestServerLayer())),
		{ timeout: 30000 }
	)
})
