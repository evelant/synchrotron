import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("Sync Divergence Scenarios", () => {
	it.scoped(
		"should create SYNC action when local apply diverges from remote patches",
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
				const syncResultB = yield* clientB.syncService.performSync()

				// --- Assert ---
				// Client B should have applied actionA's logic *locally*, resulting in different content
				const noteB_final = yield* clientB.noteRepo.findById(noteId)
				expect(noteB_final._tag).toBe("Some")
				if (noteB_final._tag === "Some") {
					// Client B's logic sets content to baseContent when condition fails
					expect(noteB_final.value.content).toBe(baseContent)
				}

				// Client B should have created an _InternalSyncApply action due to divergence
				const syncApplyActionsB = yield* clientB.actionRecordRepo.findByTag("_InternalSyncApply")
				expect(syncApplyActionsB.length).toBe(1)
					const syncApplyAction = syncApplyActionsB[0]
					expect(syncApplyAction).toBeDefined()
					if (!syncApplyAction) return // Type guard

					// The SYNC action should be sent immediately in the same sync pass.
					expect(syncApplyAction.synced).toBe(true)

				// Fetch the ActionModifiedRows associated with the SYNC action
				const syncApplyAmrs = yield* clientB.actionModifiedRowRepo.findByActionRecordIds([
					syncApplyAction.id
				])
				expect(syncApplyAmrs.length).toBe(1) // Should only modify the content field
				const syncApplyAmr = syncApplyAmrs[0]
				expect(syncApplyAmr).toBeDefined()

				if (syncApplyAmr) {
					expect(syncApplyAmr.table_name).toBe("notes")
					expect(syncApplyAmr.row_id).toBe(noteId)
					expect(syncApplyAmr.operation).toBe("UPDATE") // It's an update operation
					// Forward patches reflect the state Client B calculated locally
					expect(syncApplyAmr.forward_patches).toHaveProperty("content", baseContent)
					// Reverse patches should reflect the state *before* Client B applied the logic
					expect(syncApplyAmr.reverse_patches).toHaveProperty("content", initialContent)
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
		"should apply received SYNC action directly",
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
						title: "SYNC Apply Test",
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

				// 5. ClientB syncs, receives actionA, applies locally, diverges, creates SYNC action
				yield* clientB.syncService.performSync()
				const syncApplyActionsB = yield* clientB.actionRecordRepo.findByTag("_InternalSyncApply")
				expect(syncApplyActionsB.length).toBe(1)
				const syncActionBRecord = syncApplyActionsB[0]
				expect(syncActionBRecord).toBeDefined()
				if (!syncActionBRecord) return // Type guard

				// 6. ClientB syncs again to send its SYNC action to the server
				yield* Effect.log("--- Client B Syncing (Sending SYNC Action) ---")
				yield* clientB.syncService.performSync()

				// --- Act ---
				// 7. ClientC syncs. Should receive actionA AND syncActionBRecord.
				// The SyncService should handle applying actionA, detecting divergence (like B did),
				// but then applying syncActionBRecord's patches directly, overwriting the divergence.
				yield* Effect.log("--- Client C Syncing (Applying SYNC Action) ---")
				const syncResultC = yield* clientC.syncService.performSync()

				// --- Assert ---
				// Client C's final state should reflect the SYNC action from B
				const noteC_final = yield* clientC.noteRepo.findById(noteId)
				expect(noteC_final._tag).toBe("Some")
				if (noteC_final._tag === "Some") {
					// Content should match Client B's divergent state after applying B's SYNC action patches
					expect(noteC_final.value.content).toBe(baseContent)
				}

				// Client C should have exactly ONE SYNC action: the one received from B.
				const syncApplyActionsC = yield* clientC.actionRecordRepo.findByTag("_InternalSyncApply")
				expect(syncApplyActionsC.length).toBe(1)
				const syncActionOnC = syncApplyActionsC[0]
				expect(syncActionOnC).toBeDefined()
				// Verify it's the one from B and it's applied + synced
				if (syncActionOnC) {
					expect(syncActionOnC.id).toBe(syncActionBRecord.id)
					const isSyncAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(syncActionOnC.id)
					expect(isSyncAppliedC).toBe(true)
					expect(syncActionOnC.synced).toBe(true)
				}

				// The original action from A should be marked applied on C
				const isOriginalAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(actionA.id)
				expect(isOriginalAppliedC).toBe(true)

				// The SYNC action from B should be marked applied on C
				const isSyncBAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(
					syncActionBRecord.id
				)
				expect(isSyncBAppliedC).toBe(true)
				// It should also be marked synced as it came from the server
				const syncActionCOnC = yield* clientC.actionRecordRepo.findById(syncActionBRecord.id)
				expect(syncActionCOnC._tag).toBe("Some")
				if (syncActionCOnC._tag === "Some") {
					expect(syncActionCOnC.value.synced).toBe(true)
				}
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer for the test
	)

	it.scoped("should keep placeholder SYNC when received SYNC does not cover local divergence", () =>
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
					title: "SYNC Apply Extra Divergence Test",
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

			// 5. ClientB syncs, receives actionA, applies locally, diverges, creates SYNC action
			yield* clientB.syncService.performSync()
			const syncApplyActionsB = yield* clientB.actionRecordRepo.findByTag("_InternalSyncApply")
			expect(syncApplyActionsB.length).toBe(1)
			const syncActionBRecord = syncApplyActionsB[0]
			expect(syncActionBRecord).toBeDefined()
			if (!syncActionBRecord) return

			// 6. ClientB syncs again to send its SYNC action to the server
			yield* clientB.syncService.performSync()

			// --- Act ---
			// 7. ClientC syncs. Should receive actionA AND syncActionBRecord.
			// ClientC should still keep its own placeholder SYNC because it has additional divergence (tags).
			yield* clientC.syncService.performSync()

			// --- Assert ---
			const noteC_final = yield* clientC.noteRepo.findById(noteId)
			expect(noteC_final._tag).toBe("Some")
			if (noteC_final._tag === "Some") {
				expect(noteC_final.value.content).toBe(baseContent)
				expect(noteC_final.value.tags).toEqual(clientCTags)
			}

			const syncApplyActionsC = yield* clientC.actionRecordRepo.findByTag("_InternalSyncApply")
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

			// The original action from A should be marked applied on C
			const isOriginalAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(actionA.id)
			expect(isOriginalAppliedC).toBe(true)

			// The SYNC action from B should be marked applied on C
			const isSyncBAppliedC = yield* clientC.actionRecordRepo.isLocallyApplied(syncActionBRecord.id)
			expect(isSyncBAppliedC).toBe(true)
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
				const actionA_update = yield* clientA.syncService.executeAction(
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
