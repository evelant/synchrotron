import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { CorrectionActionTag } from "@synchrotron/sync-core/SyncActionTags"
import { Effect, Option } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("Sync Divergence Scenarios", () => {
	it.scoped(
		"should create CORRECTION action when local apply diverges from remote patches",
		() =>
			Effect.gen(function* () {
				// --- Arrange ---
				const serverSql = yield* PgliteClient.PgliteClient
				const clientA = yield* createTestClient("clientA", serverSql)
				const clientB = yield* createTestClient("clientB", serverSql)
				const baseContent = "Base Content"
				const suffixA = " Suffix Client A"
				const initialContent = "Initial" // Added for clarity

				// 1. ClientA creates initial note
				const { result } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "Divergence Test",
						content: initialContent, // Use initial content variable
						user_id: "user1"
					})
				)
				const noteId = result.id

				// 2. Sync both clients to establish common state
				yield* clientA.syncService.performSync()
				yield* clientB.syncService.performSync()

				// 3. ClientA executes conditional update (will add suffix)
				const { actionRecord: actionA } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.conditionalUpdateAction({
						id: noteId,
						baseContent: baseContent, // This base content doesn't match initial, so condition fails on B
						conditionalSuffix: suffixA
					})
				)
				// Verify Client A's state (condition should pass for A)
				const noteA_afterAction = yield* clientA.noteRepo.findById(noteId)
				expect(noteA_afterAction.pipe(Option.map((n) => n.content)).pipe(Option.getOrThrow)).toBe(
					baseContent + suffixA
				)

				// 4. ClientA syncs action to server
				yield* clientA.syncService.performSync()

				// --- Act ---
				// 5. ClientB syncs, receives actionA, applies it locally (divergence expected)
				yield* Effect.log("--- Client B Syncing (Divergence Expected) ---")
				yield* clientB.syncService.performSync()

				// --- Assert ---
				// Client B should have applied actionA's logic *locally*, resulting in different content
				const noteB_final = yield* clientB.noteRepo.findById(noteId)
				expect(noteB_final._tag).toBe("Some")
				if (noteB_final._tag === "Some") {
					// Client B's logic sets content to baseContent when condition fails
					expect(noteB_final.value.content).toBe(baseContent)
				}

				// Client B should have created a CORRECTION action due to divergence
				const correctionActionsB = yield* clientB.actionRecordRepo.findByTag(CorrectionActionTag)
				expect(correctionActionsB.length).toBe(1)
				const correctionAction = correctionActionsB[0]
				expect(correctionAction).toBeDefined()
				if (!correctionAction) return // Type guard

				// The CORRECTION action should be sent immediately in the same sync pass.
				expect(correctionAction.synced).toBe(true)

				// Fetch the ActionModifiedRows associated with the CORRECTION action
				const correctionAmrs = yield* clientB.actionModifiedRowRepo.findByActionRecordIds([
					correctionAction.id
				])
				expect(correctionAmrs.length).toBe(1) // Should only modify the content field
				const correctionAmr = correctionAmrs[0]
				expect(correctionAmr).toBeDefined()

				if (correctionAmr) {
					expect(correctionAmr.table_name).toBe("notes")
					expect(correctionAmr.row_id).toBe(noteId)
					expect(correctionAmr.operation).toBe("UPDATE") // It's an update operation
					// Forward patches reflect the state Client B calculated locally
					expect(correctionAmr.forward_patches).toHaveProperty("content", baseContent)
					// Reverse patches should reflect the state *before* Client B applied the logic
					expect(correctionAmr.reverse_patches).toHaveProperty("content", initialContent)
				}

				// The original remote action (actionA) should be marked as applied on Client B
				const isOriginalActionAppliedB = yield* clientB.actionRecordRepo.isLocallyApplied(
					actionA.id
				)
				expect(isOriginalActionAppliedB).toBe(true)
				// It should also be marked as synced because it came from the server
				const originalActionB = yield* clientB.actionRecordRepo.findById(actionA.id)
				expect(originalActionB._tag).toBe("Some")
				if (originalActionB._tag === "Some") {
					expect(originalActionB.value.synced).toBe(true)
				}
			}).pipe(Effect.provide(makeTestLayers("server"))), // Provide layer for the test
		{ timeout: 30000 }
	)

	it.scoped(
		"should apply received CORRECTION action directly",
		() =>
			Effect.gen(function* () {
				// --- Arrange ---
				const serverSql = yield* PgliteClient.PgliteClient
				const clientA = yield* createTestClient("clientA", serverSql)
				const clientB = yield* createTestClient("clientB", serverSql)
				const clientC = yield* createTestClient("clientC", serverSql)
				const baseContent = "Base Apply"
				const suffixA = " Suffix Apply A"
				const initialContent = "Initial Apply"

				// 1. ClientA creates initial note
				const { result } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "CORRECTION Apply Test",
						content: initialContent,
						user_id: "user1"
					})
				)
				const noteId = result.id

				// 2. Sync all clients
				yield* clientA.syncService.performSync()
				yield* clientB.syncService.performSync()
				yield* clientC.syncService.performSync()

				// 3. ClientA executes conditional update (adds suffix)
				const { actionRecord: actionA } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.conditionalUpdateAction({
						id: noteId,
						baseContent: baseContent, // Condition will fail on B and C
						conditionalSuffix: suffixA
					})
				)

				// 4. ClientA syncs action to server
				yield* clientA.syncService.performSync()

				// 5. ClientB syncs, receives actionA, applies locally, diverges, creates CORRECTION action
				yield* clientB.syncService.performSync()
				const correctionActionsB = yield* clientB.actionRecordRepo.findByTag(CorrectionActionTag)
				expect(correctionActionsB.length).toBe(1)
				const correctionActionBRecord = correctionActionsB[0]
				expect(correctionActionBRecord).toBeDefined()
				if (!correctionActionBRecord) return // Type guard

				// 6. ClientB syncs again to send its CORRECTION action to the server
				yield* Effect.log("--- Client B Syncing (Sending CORRECTION Action) ---")
				yield* clientB.syncService.performSync()

				// --- Act ---
				// 7. ClientC syncs. Should receive actionA AND correctionActionBRecord.
				// The SyncService should handle applying actionA, detecting divergence (like B did),
				// but then applying correctionActionBRecord's patches directly, overwriting the divergence.
				yield* Effect.log("--- Client C Syncing (Applying CORRECTION Action) ---")
				yield* clientC.syncService.performSync()

				// --- Assert ---
				// Client C's final state should reflect the CORRECTION action from B
				const noteC_final = yield* clientC.noteRepo.findById(noteId)
				expect(noteC_final._tag).toBe("Some")
				if (noteC_final._tag === "Some") {
					// Content should match Client B's divergent state after applying B's CORRECTION action patches
					expect(noteC_final.value.content).toBe(baseContent)
				}

				// Client C should have exactly ONE CORRECTION action: the one received from B.
				const correctionActionsC = yield* clientC.actionRecordRepo.findByTag(CorrectionActionTag)
				expect(correctionActionsC.length).toBe(1)
				const correctionActionOnC = correctionActionsC[0]
				expect(correctionActionOnC).toBeDefined()
				// Verify it's the one from B and it's applied + synced
				if (correctionActionOnC) {
					expect(correctionActionOnC.id).toBe(correctionActionBRecord.id)
					const isCorrectionAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(
						correctionActionOnC.id
					)
					expect(isCorrectionAppliedC).toBe(true)
					expect(correctionActionOnC.synced).toBe(true)
				}

				// The original action from A should be marked applied on C
				const isOriginalAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(actionA.id)
				expect(isOriginalAppliedC).toBe(true)

				// The CORRECTION action from B should be marked applied on C
				const isCorrectionBAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(
					correctionActionBRecord.id
				)
				expect(isCorrectionBAppliedC).toBe(true)
				// It should also be marked synced as it came from the server
				const correctionActionOnCOption = yield* clientC.actionRecordRepo.findById(
					correctionActionBRecord.id
				)
				expect(correctionActionOnCOption._tag).toBe("Some")
				if (correctionActionOnCOption._tag === "Some") {
					expect(correctionActionOnCOption.value.synced).toBe(true)
				}
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer for the test
	)

	it.scoped(
		"should keep placeholder CORRECTION when received CORRECTION does not cover local divergence",
		() =>
			Effect.gen(function* () {
				// --- Arrange ---
				const serverSql = yield* PgliteClient.PgliteClient
				const clientA = yield* createTestClient("clientA", serverSql)
				const clientB = yield* createTestClient("clientB", serverSql)
				const clientC = yield* createTestClient("clientC", serverSql)
				const baseContent = "Base Apply + Extra"
				const suffixA = " Suffix Apply A"
				const initialContent = "Initial Apply"
				const clientCTags = ["clientC"]

				// 1. ClientA creates initial note
				const { result } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "CORRECTION Apply Extra Divergence Test",
						content: initialContent,
						user_id: "user1"
					})
				)
				const noteId = result.id

				// 2. Sync all clients
				yield* clientA.syncService.performSync()
				yield* clientB.syncService.performSync()
				yield* clientC.syncService.performSync()

				// 3. ClientA executes conditional update (adds suffix); clientC will additionally update tags.
				const { actionRecord: actionA } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.conditionalUpdateWithClientCExtraAction({
						id: noteId,
						baseContent: baseContent, // Condition will fail on B and C (they don't add suffix)
						conditionalSuffix: suffixA,
						clientCTags
					})
				)

				// 4. ClientA syncs action to server
				yield* clientA.syncService.performSync()

				// 5. ClientB syncs, receives actionA, applies locally, diverges, creates CORRECTION action
				yield* clientB.syncService.performSync()
				const correctionActionsB = yield* clientB.actionRecordRepo.findByTag(CorrectionActionTag)
				expect(correctionActionsB.length).toBe(1)
				const correctionActionBRecord = correctionActionsB[0]
				expect(correctionActionBRecord).toBeDefined()
				if (!correctionActionBRecord) return

				// 6. ClientB syncs again to send its CORRECTION action to the server
				yield* clientB.syncService.performSync()

				// --- Act ---
				// 7. ClientC syncs. Should receive actionA AND correctionActionBRecord.
				// ClientC should still keep its own placeholder CORRECTION because it has additional divergence (tags).
				yield* clientC.syncService.performSync()

				// --- Assert ---
				const noteC_final = yield* clientC.noteRepo.findById(noteId)
				expect(noteC_final._tag).toBe("Some")
				if (noteC_final._tag === "Some") {
					expect(noteC_final.value.content).toBe(baseContent)
					expect(noteC_final.value.tags).toEqual(clientCTags)
				}

				const correctionActionsC = yield* clientC.actionRecordRepo.findByTag(CorrectionActionTag)
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

				// The original action from A should be marked applied on C
				const isOriginalAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(actionA.id)
				expect(isOriginalAppliedC).toBe(true)

				// The CORRECTION action from B should be marked applied on C
				const isCorrectionBAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(
					correctionActionBRecord.id
				)
				expect(isCorrectionBAppliedC).toBe(true)
			}).pipe(Effect.provide(makeTestLayers("server")))
	)

	it.scopedLive(
		"should reconcile locally when pending action conflicts with newer remote action",
		() =>
			// This test now verifies client-side reconciliation preempts server rejection
			Effect.gen(function* () {
				// --- Arrange ---
				const serverSql = yield* PgliteClient.PgliteClient
				const clientA = yield* createTestClient("clientA", serverSql)
				const clientB = yield* createTestClient("clientB", serverSql)

				// 1. ClientA creates note
				const { result } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "Initial Conflict Title",
						content: "Initial Content",
						user_id: "user1"
					})
				)
				const noteId = result.id

				// 2. ClientA syncs, ClientB syncs to get the note
				yield* clientA.syncService.performSync()
				yield* clientB.syncService.performSync()

				// 3. ClientA updates title and syncs (Server now has a newer version)
				yield* clientA.syncService.executeAction(
					clientA.testHelpers.updateTitleAction({
						id: noteId,
						title: "Title from A"
					})
				)
				yield* clientA.syncService.performSync()

				// 4. ClientB updates title offline (creates a pending action)
				const { actionRecord: actionB_update } = yield* clientB.syncService.executeAction(
					clientB.testHelpers.updateTitleAction({
						id: noteId,
						title: "Title from B"
					})
				)

				// --- Act ---
				// 5. ClientB attempts to sync.
				//    ACTUAL BEHAVIOR: Client B detects HLC conflict and reconciles locally first.
				yield* Effect.log("--- Client B Syncing (Reconciliation Expected) ---")
				const syncResultB = yield* Effect.either(clientB.syncService.performSync()) // Should succeed now

				// --- Assert ---
				// Expect the sync to SUCCEED because the client reconciles locally
				expect(syncResultB._tag).toBe("Right")

				// Check that reconciliation happened on Client B
				const rollbackActionsB = yield* clientB.actionRecordRepo.findByTag("RollbackAction")
				expect(rollbackActionsB.length).toBeGreaterThan(0) // Reconciliation creates a rollback action

				// Client B's original conflicting action should now be marked as synced (as it was reconciled)
				const actionB_final = yield* clientB.actionRecordRepo.findById(actionB_update.id)
				expect(actionB_final._tag).toBe("Some")
				if (actionB_final._tag === "Some") {
					expect(actionB_final.value.synced).toBe(true)
				}

				// Client B's local state should reflect the reconciled outcome (B's title wins due to later HLC)
				const noteB_final = yield* clientB.noteRepo.findById(noteId)
				expect(noteB_final._tag).toBe("Some")
				expect(noteB_final.pipe(Option.map((n) => n.title)).pipe(Option.getOrThrow)).toBe(
					"Title from B"
				)
				// yield* Effect.sleep(Duration.millis(100)) // Reverted delay addition
				// Server state should reflect the reconciled state sent by B (B's title wins)
				const serverNote = yield* serverSql<{ id: string; title: string }>`
						SELECT id, title FROM notes WHERE id = ${noteId}
					`
				expect(serverNote.length).toBe(1)
				// Check if serverNote[0] exists before accessing title
				if (serverNote[0]) {
					expect(serverNote[0].title).toBe("Title from B") // Server should have B's title after reconciliation sync
				}
			}).pipe(Effect.provide(makeTestLayers("server")))
	)
})
