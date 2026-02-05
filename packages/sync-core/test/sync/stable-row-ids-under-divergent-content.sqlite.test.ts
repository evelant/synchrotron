import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { CorrectionActionTag } from "@synchrotron/sync-core/SyncActionTags"
import { Effect } from "effect"
import { makeSqliteTestServerLayer, withSqliteTestClients } from "../helpers/SqliteTestLayers"

describe("Stable row ids under divergent content (SQLite clients) (TODO 0019)", () => {
	it.scoped(
		"uses stable row identity so divergent insert content does not create duplicate rows",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const identityByTable = {
					notes: ["user_id", "title"],
					test_apply_patches: (row: any) => row
				} as const

				yield* withSqliteTestClients(
					["clientA", "clientB"],
					serverSql,
					{ identityByTable },
					(clients) =>
						Effect.gen(function* () {
							const clientA = clients[0]!
							const clientB = clients[1]!

							const baseContent = "Base Insert"
							const { result } = yield* clientA.syncService.executeAction(
								clientA.testHelpers.createNoteClientSpecificInsertAction({
									title: "Insert Divergence",
									baseContent,
									user_id: "user1"
								})
							)
							const noteId = result.id

							yield* clientA.syncService.performSync()
							yield* clientB.syncService.performSync()

							const noteB = yield* clientB.noteRepo.findById(noteId)
							expect(noteB._tag).toBe("Some")
							if (noteB._tag === "Some") {
								expect(noteB.value.content).toBe(`${baseContent}-clientB`)
							}

							const correctionActionsB =
								yield* clientB.actionRecordRepo.findByTag(CorrectionActionTag)
							expect(correctionActionsB.length).toBe(1)
							const correctionActionB = correctionActionsB[0]
							expect(correctionActionB?.synced).toBe(true)
							if (!correctionActionB) return

							const correctionAmrsB = yield* clientB.actionModifiedRowRepo.findByActionRecordIds([
								correctionActionB.id
							])

							const correctionNoteAmrB = correctionAmrsB.find(
								(amr) => amr.table_name === "notes" && amr.row_id === noteId
							)
							expect(correctionNoteAmrB).toBeDefined()
							if (!correctionNoteAmrB) return
							expect(correctionNoteAmrB.operation).toBe("UPDATE")
							expect(correctionNoteAmrB.forward_patches).toHaveProperty(
								"content",
								`${baseContent}-clientB`
							)
							expect(correctionNoteAmrB.reverse_patches).toHaveProperty(
								"content",
								`${baseContent}-clientA`
							)

							const serverRows = yield* serverSql<{ readonly content: string }>`
									SELECT content
									FROM notes
								WHERE id = ${noteId}
							`
							expect(serverRows[0]?.content).toBe(`${baseContent}-clientB`)

							yield* clientA.syncService.performSync()
							const noteA = yield* clientA.noteRepo.findById(noteId)
							expect(noteA._tag).toBe("Some")
							if (noteA._tag === "Some") {
								expect(noteA.value.content).toBe(`${baseContent}-clientB`)
							}

							const [countA] = yield* clientA.sql<{ readonly count: number }>`
								SELECT count(*) AS count FROM notes
							`
							const [countB] = yield* clientB.sql<{ readonly count: number }>`
								SELECT count(*) AS count FROM notes
							`
							const [serverCount] = yield* serverSql<{ readonly count: number }>`
								SELECT count(*)::int AS count FROM notes
							`

							expect(countA?.count).toBe(1)
							expect(countB?.count).toBe(1)
							expect(serverCount?.count).toBe(1)
						})
				)
			}).pipe(Effect.provide(makeSqliteTestServerLayer())),
		{ timeout: 30000 }
	)
})
