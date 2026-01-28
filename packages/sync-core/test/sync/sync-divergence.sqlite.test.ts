import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { CorrectionActionTag } from "@synchrotron/sync-core/SyncActionTags"
import { Effect, Option } from "effect"
import { makeSqliteTestServerLayer, withSqliteTestClients } from "../helpers/SqliteTestLayers"

describe("Sync Divergence Scenarios (SQLite clients)", () => {
	it.scoped(
		"should create CORRECTION action when local apply diverges from remote patches",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				yield* withSqliteTestClients(["clientA", "clientB"], serverSql, (clients) =>
					Effect.gen(function* () {
						const clientA = clients[0]!
						const clientB = clients[1]!
						const baseContent = "Base Content"
						const suffixA = " Suffix Client A"
						const initialContent = "Initial"

						const { result } = yield* clientA.syncService.executeAction(
							clientA.testHelpers.createNoteAction({
								title: "Divergence Test",
								content: initialContent,
								user_id: "user1"
							})
						)
						const noteId = result.id

						yield* clientA.syncService.performSync()
						yield* clientB.syncService.performSync()

						const { actionRecord: actionA } = yield* clientA.syncService.executeAction(
							clientA.testHelpers.conditionalUpdateAction({
								id: noteId,
								baseContent,
								conditionalSuffix: suffixA
							})
						)

						const noteA_afterAction = yield* clientA.noteRepo.findById(noteId)
						expect(
							noteA_afterAction.pipe(Option.map((n) => n.content)).pipe(Option.getOrThrow)
						).toBe(baseContent + suffixA)

						yield* clientA.syncService.performSync()

						yield* Effect.log("--- Client B Syncing (Divergence Expected) ---")
						yield* clientB.syncService.performSync()

						const noteB_final = yield* clientB.noteRepo.findById(noteId)
						expect(noteB_final._tag).toBe("Some")
						if (noteB_final._tag === "Some") {
							expect(noteB_final.value.content).toBe(baseContent)
						}

						const correctionActionsB =
							yield* clientB.actionRecordRepo.findByTag(CorrectionActionTag)
						expect(correctionActionsB.length).toBe(1)
						const correctionAction = correctionActionsB[0]
						expect(correctionAction).toBeDefined()
						if (!correctionAction) return

						expect(correctionAction.synced).toBe(true)

						const correctionAmrs = yield* clientB.actionModifiedRowRepo.findByActionRecordIds([
							correctionAction.id
						])
						expect(correctionAmrs.length).toBe(1)
						const correctionAmr = correctionAmrs[0]
						expect(correctionAmr).toBeDefined()

						if (correctionAmr) {
							expect(correctionAmr.table_name).toBe("notes")
							expect(correctionAmr.row_id).toBe(noteId)
							expect(correctionAmr.operation).toBe("UPDATE")
							expect(correctionAmr.forward_patches).toHaveProperty("content", baseContent)
							expect(correctionAmr.reverse_patches).toHaveProperty("content", initialContent)
						}

						const isOriginalActionAppliedB = yield* clientB.actionRecordRepo.isLocallyApplied(
							actionA.id
						)
						expect(isOriginalActionAppliedB).toBe(true)

						const originalActionB = yield* clientB.actionRecordRepo.findById(actionA.id)
						expect(originalActionB._tag).toBe("Some")
						if (originalActionB._tag === "Some") {
							expect(originalActionB.value.synced).toBe(true)
						}
					})
				)
			}).pipe(Effect.provide(makeSqliteTestServerLayer())),
		{ timeout: 30000 }
	)

	it.scoped(
		"should apply received CORRECTION action directly",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				yield* withSqliteTestClients(["clientA", "clientB", "clientC"], serverSql, (clients) =>
					Effect.gen(function* () {
						const clientA = clients[0]!
						const clientB = clients[1]!
						const clientC = clients[2]!
						const baseContent = "Base Apply"
						const suffixA = " Suffix Apply A"
						const initialContent = "Initial Apply"

						const { result } = yield* clientA.syncService.executeAction(
							clientA.testHelpers.createNoteAction({
								title: "CORRECTION Apply Test",
								content: initialContent,
								user_id: "user1"
							})
						)
						const noteId = result.id

						yield* clientA.syncService.performSync()
						yield* clientB.syncService.performSync()

						const { actionRecord: actionA } = yield* clientA.syncService.executeAction(
							clientA.testHelpers.conditionalUpdateAction({
								id: noteId,
								baseContent,
								conditionalSuffix: suffixA
							})
						)

						yield* clientA.syncService.performSync()

						yield* clientB.syncService.performSync()
						const correctionActionsB =
							yield* clientB.actionRecordRepo.findByTag(CorrectionActionTag)
						expect(correctionActionsB.length).toBe(1)
						const correctionActionBRecord = correctionActionsB[0]
						expect(correctionActionBRecord).toBeDefined()
						if (!correctionActionBRecord) return

						yield* Effect.log("--- Client B Syncing (Sending CORRECTION Action) ---")
						yield* clientB.syncService.performSync()

						yield* Effect.log("--- Client C Syncing (Applying CORRECTION Action) ---")
						yield* clientC.syncService.performSync()

						const noteC_final = yield* clientC.noteRepo.findById(noteId)
						expect(noteC_final._tag).toBe("Some")
						if (noteC_final._tag === "Some") {
							expect(noteC_final.value.content).toBe(baseContent)
						}

						const correctionActionsC =
							yield* clientC.actionRecordRepo.findByTag(CorrectionActionTag)
						expect(correctionActionsC.length).toBe(1)
						const correctionActionOnC = correctionActionsC[0]
						expect(correctionActionOnC).toBeDefined()
						if (correctionActionOnC) {
							expect(correctionActionOnC.id).toBe(correctionActionBRecord.id)
							const isCorrectionAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(
								correctionActionOnC.id
							)
							expect(isCorrectionAppliedC).toBe(true)
							expect(correctionActionOnC.synced).toBe(true)
						}

						const isOriginalAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(actionA.id)
						expect(isOriginalAppliedC).toBe(true)

						const isCorrectionBAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(
							correctionActionBRecord.id
						)
						expect(isCorrectionBAppliedC).toBe(true)

						const correctionActionOnCOption = yield* clientC.actionRecordRepo.findById(
							correctionActionBRecord.id
						)
						expect(correctionActionOnCOption._tag).toBe("Some")
						if (correctionActionOnCOption._tag === "Some") {
							expect(correctionActionOnCOption.value.synced).toBe(true)
						}
					})
				)
			}).pipe(Effect.provide(makeSqliteTestServerLayer())),
		{ timeout: 30000 }
	)

	it.scoped(
		"should keep placeholder CORRECTION when received CORRECTION does not cover local divergence",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				yield* withSqliteTestClients(["clientA", "clientB", "clientC"], serverSql, (clients) =>
					Effect.gen(function* () {
						const clientA = clients[0]!
						const clientB = clients[1]!
						const clientC = clients[2]!
						const baseContent = "Base Apply + Extra"
						const suffixA = " Suffix Apply A"
						const initialContent = "Initial Apply"
						const clientCTags = ["clientC"]

						const { result } = yield* clientA.syncService.executeAction(
							clientA.testHelpers.createNoteAction({
								title: "CORRECTION Apply Extra Divergence Test",
								content: initialContent,
								user_id: "user1"
							})
						)
						const noteId = result.id

						yield* clientA.syncService.performSync()
						yield* clientB.syncService.performSync()
						yield* clientC.syncService.performSync()

						const { actionRecord: actionA } = yield* clientA.syncService.executeAction(
							clientA.testHelpers.conditionalUpdateWithClientCExtraAction({
								id: noteId,
								baseContent,
								conditionalSuffix: suffixA,
								clientCTags
							})
						)

						yield* clientA.syncService.performSync()

						yield* clientB.syncService.performSync()
						const correctionActionsB =
							yield* clientB.actionRecordRepo.findByTag(CorrectionActionTag)
						expect(correctionActionsB.length).toBe(1)
						const correctionActionBRecord = correctionActionsB[0]
						expect(correctionActionBRecord).toBeDefined()
						if (!correctionActionBRecord) return

						expect(correctionActionBRecord.synced).toBe(true)

						yield* clientB.syncService.performSync()

						yield* clientC.syncService.performSync()

						const noteC_final = yield* clientC.noteRepo.findById(noteId)
						expect(noteC_final._tag).toBe("Some")
						if (noteC_final._tag === "Some") {
							expect(noteC_final.value.content).toBe(baseContent)
							expect(noteC_final.value.tags).toEqual(clientCTags)
						}

						const correctionActionsC =
							yield* clientC.actionRecordRepo.findByTag(CorrectionActionTag)
						expect(correctionActionsC.length).toBe(2)

						const receivedCorrectionOnC = correctionActionsC.find(
							(a) => a.id === correctionActionBRecord.id
						)
						const localCorrectionOnC = correctionActionsC.find(
							(a) => a.id !== correctionActionBRecord.id
						)
						expect(receivedCorrectionOnC).toBeDefined()
						expect(localCorrectionOnC).toBeDefined()
						if (!receivedCorrectionOnC || !localCorrectionOnC) return

						expect(receivedCorrectionOnC.synced).toBe(true)
						expect(localCorrectionOnC.synced).toBe(true)

						const localCorrectionAmrs = yield* clientC.actionModifiedRowRepo.findByActionRecordIds([
							localCorrectionOnC.id
						])
						expect(localCorrectionAmrs.length).toBeGreaterThan(0)
						const hasTagsPatch = localCorrectionAmrs.some((amr) =>
							Object.prototype.hasOwnProperty.call(amr.forward_patches, "tags")
						)
						expect(hasTagsPatch).toBe(true)

						const isOriginalAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(actionA.id)
						expect(isOriginalAppliedC).toBe(true)

						const isCorrectionBAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(
							correctionActionBRecord.id
						)
						expect(isCorrectionBAppliedC).toBe(true)
					})
				)
			}).pipe(Effect.provide(makeSqliteTestServerLayer())),
		{ timeout: 30000 }
	)

	it.scoped(
		"should reconcile locally when pending action conflicts with newer remote action",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				yield* withSqliteTestClients(["clientA", "clientB"], serverSql, (clients) =>
					Effect.gen(function* () {
						const clientA = clients[0]!
						const clientB = clients[1]!

						const { result } = yield* clientA.syncService.executeAction(
							clientA.testHelpers.createNoteAction({
								title: "Initial Conflict Title",
								content: "Initial Content",
								user_id: "user1"
							})
						)
						const noteId = result.id

						yield* clientA.syncService.performSync()
						yield* clientB.syncService.performSync()

						yield* clientA.syncService.executeAction(
							clientA.testHelpers.updateTitleAction({
								id: noteId,
								title: "Title from A"
							})
						)
						yield* clientA.syncService.performSync()

						const { actionRecord: actionB_update } = yield* clientB.syncService.executeAction(
							clientB.testHelpers.updateTitleAction({
								id: noteId,
								title: "Title from B"
							})
						)

						yield* Effect.log("--- Client B Syncing (Reconciliation Expected) ---")
						const syncResultB = yield* Effect.either(clientB.syncService.performSync())

						expect(syncResultB._tag).toBe("Right")

						const rollbackActionsB = yield* clientB.actionRecordRepo.findByTag("RollbackAction")
						expect(rollbackActionsB.length).toBeGreaterThan(0)

						const actionB_final = yield* clientB.actionRecordRepo.findById(actionB_update.id)
						expect(actionB_final._tag).toBe("Some")
						if (actionB_final._tag === "Some") {
							expect(actionB_final.value.synced).toBe(true)
						}

						const noteB_final = yield* clientB.noteRepo.findById(noteId)
						expect(noteB_final._tag).toBe("Some")
						expect(noteB_final.pipe(Option.map((n) => n.title)).pipe(Option.getOrThrow)).toBe(
							"Title from B"
						)

						const serverNote = yield* serverSql<{ id: string; title: string }>`
							SELECT id, title FROM notes WHERE id = ${noteId}
						`
						expect(serverNote.length).toBe(1)
						if (serverNote[0]) {
							expect(serverNote[0].title).toBe("Title from B")
						}
					})
				)
			}).pipe(Effect.provide(makeSqliteTestServerLayer())),
		{ timeout: 30000 }
	)
})
