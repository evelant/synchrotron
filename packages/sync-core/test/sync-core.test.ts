import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest" // Import describe
import { ActionRecord } from "@synchrotron/sync-core/models" // Import ActionRecord directly
import { Effect, TestClock } from "effect"
import { createTestClient, makeTestLayers } from "./helpers/TestLayers"

// Use the specific NoteModel from TestLayers if it's defined there, otherwise import from models
// Assuming NoteModel is defined in TestLayers or accessible globally for tests
// import { NoteModel } from "packages/sync/test/helpers/TestLayers"

// Use describe instead of it.layer
describe("Core Sync Functionality", () => {
	// --- Test 1: Basic Send/Receive ---
	// Provide the layer individually to each test using .pipe(Effect.provide(...))
	it.scoped(
		"should synchronize a new action from client1 to client2",
		() =>
			Effect.gen(function* () {
				// Removed TestServices context type
				const serverSql = yield* PgliteClient.PgliteClient
				const client1 = yield* createTestClient("client1", serverSql).pipe(Effect.orDie)
				const client2 = yield* createTestClient("client2", serverSql).pipe(Effect.orDie)

				// 1. Client 1 creates a note
				const { result } = yield* client1.syncService.executeAction(
					client1.testHelpers.createNoteAction({
						title: "Title C1",
						content: "Content C1",
						tags: [],
						user_id: "user1"
					})
				)
				const noteId = result.id

				// 2. Client 1 syncs (Case 2: Sends local actions)
				const c1Synced = yield* client1.syncService.performSync()
				expect(c1Synced.length).toBe(1) // Verify one action was sent/marked synced

				// 3. Client 2 syncs (Case 1: Receives remote actions, no pending)
				const c2Received = yield* client2.syncService.performSync()
				expect(c2Received.length).toBe(1) // Verify one action was received/applied

				// 4. Verify note exists on both clients
				const noteC1 = yield* client1.noteRepo.findById(noteId)
				const noteC2 = yield* client2.noteRepo.findById(noteId)

				expect(noteC1._tag).toBe("Some")
				expect(noteC2._tag).toBe("Some")
				if (noteC1._tag === "Some" && noteC2._tag === "Some") {
					expect(noteC1.value.title).toBe("Title C1")
					expect(noteC2.value.title).toBe("Title C1")
				}
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// --- Test 2: Case 4 (Remote Newer) - No Conflict/Divergence ---
	it.scoped(
		"should handle remote actions arriving after local pending actions",
		() =>
			Effect.gen(function* () {
				// Removed TestServices context type
				const serverSql = yield* PgliteClient.PgliteClient
				const client1 = yield* createTestClient("client1", serverSql) // Renamed from client7
				const client2 = yield* createTestClient("client2", serverSql) // Renamed from client8

				yield* Effect.log("--- Setting up Case 4: Local A < Remote B ---")

				// 1. Client 1 creates Action A (local pending)
				const { result: actionAResult, actionRecord: actionA } =
					yield* client1.syncService.executeAction(
						// Renamed from actionA7
						client1.testHelpers.createNoteAction({
							title: "Note A",
							content: "",
							user_id: "user1"
						})
					)
				const noteAId = actionAResult.id

				// 2. Client 2 creates Action B (newer HLC), syncs B to server
				yield* TestClock.adjust("10 millis") // Ensure B's clock is newer
				const { result: actionBResult, actionRecord: actionB } =
					yield* client2.syncService.executeAction(
						// Renamed from actionB8
						client2.testHelpers.createNoteAction({
							title: "Note B",
							content: "",
							user_id: "user1"
						})
					)
				const noteBId = actionBResult.id
				yield* client2.syncService.performSync() // Server now has B

				// 3. Client 1 syncs. Pending: [A]. Remote: [B].
				// Expected: latestPending(A) < earliestRemote(B) -> Case 4
				// Client 1 should apply B and send A.
				yield* Effect.log("--- Client 1 Syncing (Case 4 expected) ---")
				const c1SyncResult = yield* client1.syncService.performSync()

				// Verification for Case 4:
				// - Remote action B was applied locally on Client 1.
				// - Local pending action A was sent to the server and marked synced on Client 1.
				// - Both notes A and B should exist on Client 1.
				// - Server should now have both A and B.

				const noteA_C1 = yield* client1.noteRepo.findById(noteAId)
				const noteB_C1 = yield* client1.noteRepo.findById(noteBId)
				expect(noteA_C1._tag).toBe("Some")
				expect(noteB_C1._tag).toBe("Some")

				const syncedActionA = yield* client1.actionRecordRepo.findById(actionA.id)
				expect(syncedActionA._tag).toBe("Some")
				if (syncedActionA._tag === "Some") {
					expect(syncedActionA.value.synced).toBe(true)
				}

				// Verify server state
				const serverActions = yield* serverSql<ActionRecord>`
				SELECT * FROM action_records
				ORDER BY clock_time_ms ASC, clock_counter ASC, client_id ASC, id ASC
			`
				expect(serverActions.length).toBe(2)
				// Order depends on HLC comparison, B should be first as it was created later but synced first
				const serverActionIds = serverActions.map((a) => a.id)
				expect(serverActionIds).toContain(actionA.id)
				expect(serverActionIds).toContain(actionB.id)
				// Check order based on HLC (assuming B's HLC is greater)
				const actionAFromServer = serverActions.find((a) => a.id === actionA.id)
				const actionBFromServer = serverActions.find((a) => a.id === actionB.id)
				if (actionAFromServer && actionBFromServer) {
					// Assuming ClockService correctly orders HLCs as strings/objects
					expect(actionAFromServer.clock.timestamp).toBeLessThan(actionBFromServer.clock.timestamp)
				} else {
					throw new Error("Actions not found on server for HLC comparison")
				}
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	it.scoped(
		"should reconcile interleaved actions",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient
				const client1 = yield* createTestClient("client1", serverSql).pipe(Effect.orDie)
				const client2 = yield* createTestClient("client2", serverSql).pipe(Effect.orDie)

				// 1. Client 1 creates note A
				const { result: actionAResult, actionRecord: actionA } =
					yield* client1.syncService.executeAction(
						client1.testHelpers.createNoteAction({
							title: "Note R1",
							content: "",
							user_id: "user1"
						})
					)
				const noteAId = actionAResult.id

				// 2. Client 2 creates note B
				yield* TestClock.adjust("10 millis") // Ensure different clocks
				const { result: actionBResult, actionRecord: actionB } =
					yield* client2.syncService.executeAction(
						client2.testHelpers.createNoteAction({
							title: "Note R2",
							content: "",
							user_id: "user1"
						})
					)
				const noteBId = actionBResult.id

				// 3. Client 1 syncs (sends A)
				yield* client1.syncService.performSync()

				// 4. Client 2 syncs. Pending: [B]. Remote: [A].
				// Clocks are likely interleaved (latestPending(B) > earliestRemote(A) is true, AND latestRemote(A) > earliestPending(B) is true)
				// -> Case 5 -> reconcile
				yield* Effect.log("--- Client 2 Syncing (Reconciliation expected) ---")
				const c2SyncResult = yield* client2.syncService.performSync()

				// Verification for Reconciliation:
				// 1. `reconcile` was called implicitly.
				// 2. Rollback action should exist.
				// 3. Replayed actions (new records for A and B) should exist.
				// 4. Original pending action B should be marked synced.
				// 5. Both notes R1 and R2 should exist on Client 2.
				// 6. Server should have original A, original B, Rollback, new A, new B (or similar, depending on exact reconcile impl)

				const noteA_C2 = yield* client2.noteRepo.findById(noteAId)
				const noteB_C2 = yield* client2.noteRepo.findById(noteBId)
				expect(noteA_C2._tag).toBe("Some")
				expect(noteB_C2._tag).toBe("Some")

				// Verify original action B is marked synced (even though it wasn't "replayed" in the new sense)
				const originalActionB = yield* client2.actionRecordRepo.findById(actionB.id)
				expect(originalActionB._tag).toBe("Some")
				// Add check before accessing value
				if (originalActionB._tag === "Some") {
					expect(originalActionB.value.synced).toBe(true)
				}
				// Check for rollback action (assuming tag is 'RollbackAction')
				const rollbackActions = yield* client2.actionRecordRepo.findByTag("RollbackAction") // Correct tag
				expect(rollbackActions.length).toBeGreaterThan(0)

				// Check for replayed actions (will have newer clocks than original A and B)
				const allActionsC2 = yield* client2.actionRecordRepo.all()
				const replayedA = allActionsC2.find(
					(a: ActionRecord) => a._tag === actionA._tag && a.id !== actionA.id
				) // Added type
				const replayedB = allActionsC2.find(
					(a: ActionRecord) => a._tag === actionB._tag && a.id !== actionB.id
				) // Added type
				expect(replayedA).toBeDefined()
				expect(replayedB).toBeDefined()
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)
})
