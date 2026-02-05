import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { CorrectionActionTag } from "@synchrotron/sync-core/SyncActionTags"
import { Effect } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("Stable row ids under divergent content (TODO 0019)", () => {
	it.scoped(
		"uses stable row identity so divergent insert content does not create duplicate rows",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const identityByTable = {
					notes: ["user_id", "title"],
					test_apply_patches: (row: any) => row
				} as const

				const clientA = yield* createTestClient("clientA", serverSql, { identityByTable })
				const clientB = yield* createTestClient("clientB", serverSql, { identityByTable })

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

				const correctionActionsB = yield* clientB.actionRecordRepo.findByTag(CorrectionActionTag)
				expect(correctionActionsB.length).toBe(1)
				const correctionActionB = correctionActionsB[0]
				expect(correctionActionB?.synced).toBe(true)
				if (!correctionActionB) return

				const correctionAmrsB = yield* clientB.actionModifiedRowRepo.findByActionRecordIds([
					correctionActionB.id
				])

				// Key property for TODO 0019: even though replay inserted the row, outgoing CORRECTION must
				// treat it as an UPDATE on the already-known row id (so it can apply/rollback correctly).
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
				// Reverse patch must restore the previously-known end state (origin patch set),
				// otherwise rollback semantics are incorrect.
				expect(correctionNoteAmrB.reverse_patches).toHaveProperty(
					"content",
					`${baseContent}-clientA`
				)

				// Server materialization should reflect the CORRECTION overwrite.
				const serverRows = yield* serverSql<{ readonly content: string }>`
						SELECT content
					FROM notes
					WHERE id = ${noteId}
				`
				expect(serverRows[0]?.content).toBe(`${baseContent}-clientB`)

				// Client A receives the CORRECTION and converges.
				yield* clientA.syncService.performSync()
				const noteA = yield* clientA.noteRepo.findById(noteId)
				expect(noteA._tag).toBe("Some")
				if (noteA._tag === "Some") {
					expect(noteA.value.content).toBe(`${baseContent}-clientB`)
				}

				const [countA] = yield* clientA.rawSql<{ readonly count: number }>`
					SELECT count(*)::int AS count FROM notes
				`
				const [countB] = yield* clientB.rawSql<{ readonly count: number }>`
					SELECT count(*)::int AS count FROM notes
				`
				const [serverCount] = yield* serverSql<{ readonly count: number }>`
					SELECT count(*)::int AS count FROM notes
				`

				expect(countA?.count).toBe(1)
				expect(countB?.count).toBe(1)
				expect(serverCount?.count).toBe(1)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
