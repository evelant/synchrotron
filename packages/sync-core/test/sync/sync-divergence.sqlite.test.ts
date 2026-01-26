import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { makeSqliteTestServerLayer, withSqliteTestClients } from "../helpers/SqliteTestLayers"

describe("Sync Divergence Scenarios (SQLite clients)", () => {
	it.scoped(
		"should create SYNC action when local apply diverges from remote patches",
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

						const syncApplyActionsB =
							yield* clientB.actionRecordRepo.findByTag("_InternalSyncApply")
						expect(syncApplyActionsB.length).toBe(1)
						const syncApplyAction = syncApplyActionsB[0]
						expect(syncApplyAction).toBeDefined()
						if (!syncApplyAction) return

						expect(syncApplyAction.synced).toBe(true)

						const syncApplyAmrs = yield* clientB.actionModifiedRowRepo.findByActionRecordIds([
							syncApplyAction.id
						])
						expect(syncApplyAmrs.length).toBe(1)
						const syncApplyAmr = syncApplyAmrs[0]
						expect(syncApplyAmr).toBeDefined()

						if (syncApplyAmr) {
							expect(syncApplyAmr.table_name).toBe("notes")
							expect(syncApplyAmr.row_id).toBe(noteId)
							expect(syncApplyAmr.operation).toBe("UPDATE")
							expect(syncApplyAmr.forward_patches).toHaveProperty("content", baseContent)
							expect(syncApplyAmr.reverse_patches).toHaveProperty("content", initialContent)
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
		"should apply received SYNC action directly",
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
								title: "SYNC Apply Test",
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
						const syncApplyActionsB =
							yield* clientB.actionRecordRepo.findByTag("_InternalSyncApply")
						expect(syncApplyActionsB.length).toBe(1)
						const syncActionBRecord = syncApplyActionsB[0]
						expect(syncActionBRecord).toBeDefined()
						if (!syncActionBRecord) return

						yield* Effect.log("--- Client B Syncing (Sending SYNC Action) ---")
						yield* clientB.syncService.performSync()

						yield* Effect.log("--- Client C Syncing (Applying SYNC Action) ---")
						yield* clientC.syncService.performSync()

						const noteC_final = yield* clientC.noteRepo.findById(noteId)
						expect(noteC_final._tag).toBe("Some")
						if (noteC_final._tag === "Some") {
							expect(noteC_final.value.content).toBe(baseContent)
						}

						const syncApplyActionsC =
							yield* clientC.actionRecordRepo.findByTag("_InternalSyncApply")
						expect(syncApplyActionsC.length).toBe(1)
						const syncActionOnC = syncApplyActionsC[0]
						expect(syncActionOnC).toBeDefined()
						if (syncActionOnC) {
							expect(syncActionOnC.id).toBe(syncActionBRecord.id)
							const isSyncAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(
								syncActionOnC.id
							)
							expect(isSyncAppliedC).toBe(true)
							expect(syncActionOnC.synced).toBe(true)
						}

						const isOriginalAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(actionA.id)
						expect(isOriginalAppliedC).toBe(true)

						const isSyncBAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(
							syncActionBRecord.id
						)
						expect(isSyncBAppliedC).toBe(true)

						const syncActionCOnC = yield* clientC.actionRecordRepo.findById(syncActionBRecord.id)
						expect(syncActionCOnC._tag).toBe("Some")
						if (syncActionCOnC._tag === "Some") {
							expect(syncActionCOnC.value.synced).toBe(true)
						}
					})
				)
			}).pipe(Effect.provide(makeSqliteTestServerLayer())),
		{ timeout: 30000 }
	)

	it.scoped(
		"should keep placeholder SYNC when received SYNC does not cover local divergence",
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
								title: "SYNC Apply Extra Divergence Test",
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
						const syncApplyActionsB =
							yield* clientB.actionRecordRepo.findByTag("_InternalSyncApply")
						expect(syncApplyActionsB.length).toBe(1)
						const syncActionBRecord = syncApplyActionsB[0]
						expect(syncActionBRecord).toBeDefined()
						if (!syncActionBRecord) return

						expect(syncActionBRecord.synced).toBe(true)

						yield* clientB.syncService.performSync()

						yield* clientC.syncService.performSync()

						const noteC_final = yield* clientC.noteRepo.findById(noteId)
						expect(noteC_final._tag).toBe("Some")
						if (noteC_final._tag === "Some") {
							expect(noteC_final.value.content).toBe(baseContent)
							expect(noteC_final.value.tags).toEqual(clientCTags)
						}

						const syncApplyActionsC =
							yield* clientC.actionRecordRepo.findByTag("_InternalSyncApply")
						expect(syncApplyActionsC.length).toBe(2)

						const receivedSyncOnC = syncApplyActionsC.find((a) => a.id === syncActionBRecord.id)
						const localSyncOnC = syncApplyActionsC.find((a) => a.id !== syncActionBRecord.id)
						expect(receivedSyncOnC).toBeDefined()
						expect(localSyncOnC).toBeDefined()
						if (!receivedSyncOnC || !localSyncOnC) return

						expect(receivedSyncOnC.synced).toBe(true)
						expect(localSyncOnC.synced).toBe(true)

						const localSyncAmrs = yield* clientC.actionModifiedRowRepo.findByActionRecordIds([
							localSyncOnC.id
						])
						expect(localSyncAmrs.length).toBeGreaterThan(0)
						const hasTagsPatch = localSyncAmrs.some((amr) =>
							Object.prototype.hasOwnProperty.call(amr.forward_patches, "tags")
						)
						expect(hasTagsPatch).toBe(true)

						const isOriginalAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(actionA.id)
						expect(isOriginalAppliedC).toBe(true)

						const isSyncBAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(
							syncActionBRecord.id
						)
						expect(isSyncBAppliedC).toBe(true)
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
