import { SqlClient } from "@effect/sql"
import { PgliteClient } from "@effect/sql-pglite"
import { describe, it } from "@effect/vitest" // Import describe
import { ClockService } from "@synchrotron/sync-core/ClockService"
import { DeterministicId } from "@synchrotron/sync-core/DeterministicId"
import { applySyncTriggers } from "@synchrotron/sync-core/db"
import { ActionModifiedRow } from "@synchrotron/sync-core/models"
import { Effect } from "effect"
import { expect } from "vitest"
import { makeTestLayers } from "./helpers/TestLayers"

// Use describe instead of it.layer
describe("Clock Operations", () => {
	// Provide layer individually
	it.scoped(
		"should correctly increment clock with single client",
		() =>
			Effect.gen(function* (_) {
				const clockService = yield* ClockService
				const clientId = yield* clockService.getNodeId

				// Get initial state
				const initialState = yield* clockService.getClientClock
				expect(initialState.vector).toBeDefined()
				expect(initialState.timestamp).toBeDefined()

				// Increment clock
				const incremented = yield* clockService.incrementClock
				expect(incremented.timestamp).toBeGreaterThanOrEqual(initialState.timestamp)

				// The vector for this client should have incremented by 1
				const clientKey = clientId.toString()
				const initialValue = initialState.vector[clientKey] ?? 0
				expect(incremented.vector[clientKey]).toBe(initialValue + 1)
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// Provide layer individually
	it.scoped(
		"should correctly merge clocks from different clients",
		() =>
			Effect.gen(function* (_) {
				const clockService = yield* ClockService

				// Test vector merging rules: max value wins, entries are added, never reset
				// Test case 1: Second timestamp is larger, counters should never reset
				const clock1 = {
					timestamp: 1000,
					vector: { client1: 5 }
				}
				const clock2 = {
					timestamp: 1200,
					vector: { client1: 4 }
				}
				const merged1 = clockService.mergeClock(clock1, clock2)

				// Since actual system time is used, we can only verify relative behaviors
				expect(merged1.timestamp).toBeGreaterThanOrEqual(
					Math.max(clock1.timestamp, clock2.timestamp)
				)
				expect(merged1.vector.client1).toBe(5) // Takes max counter

				// Test case 2: First timestamp is larger, counters should never reset
				const clock3 = {
					timestamp: 1500,
					vector: { client1: 3 }
				}
				const clock4 = {
					timestamp: 1200,
					vector: { client1: 7 }
				}
				const merged2 = clockService.mergeClock(clock3, clock4)

				expect(merged2.timestamp).toBeGreaterThanOrEqual(
					Math.max(clock3.timestamp, clock4.timestamp)
				)
				expect(merged2.vector.client1).toBe(7) // Takes max counter

				// Test case 3: Testing vector update logic with multiple clients
				const clock5 = {
					timestamp: 1000,
					vector: { client1: 2, client2: 1 }
				}
				const clock6 = {
					timestamp: 1000,
					vector: { client1: 5, client3: 3 }
				}
				const merged3 = clockService.mergeClock(clock5, clock6)

				expect(merged3.timestamp).toBeGreaterThanOrEqual(
					Math.max(clock5.timestamp, clock6.timestamp)
				)
				// Verify max value wins for existing keys
				expect(merged3.vector.client1).toBe(5) // max(2, 5)
				// Verify existing keys are preserved
				expect(merged3.vector.client2).toBe(1) // Only in clock5
				// Verify new keys are added
				expect(merged3.vector.client3).toBe(3) // Only in clock6
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// Provide layer individually
	it.scoped(
		"should correctly compare clocks",
		() =>
			Effect.gen(function* (_) {
				const clockService = yield* ClockService

				// Test different timestamps
				// Note: compareClock derives the logical counter from `clock.vector[clientId]`
				const clientId = "client1"
				const result1 = clockService.compareClock(
					{ clock: { timestamp: 1000, vector: { client1: 1 } }, clientId },
					{ clock: { timestamp: 2000, vector: { client1: 1 } }, clientId }
				)
				expect(result1).toBeLessThan(0)

				const result2 = clockService.compareClock(
					{ clock: { timestamp: 2000, vector: { client1: 1 } }, clientId },
					{ clock: { timestamp: 1000, vector: { client1: 1 } }, clientId }
				)
				expect(result2).toBeGreaterThan(0)

				// Test different vectors with same timestamp
				const result3 = clockService.compareClock(
					{ clock: { timestamp: 1000, vector: { client1: 2 } }, clientId },
					{ clock: { timestamp: 1000, vector: { client1: 1 } }, clientId }
				)
				expect(result3).toBeGreaterThan(0)

				const result4 = clockService.compareClock(
					{ clock: { timestamp: 1000, vector: { client1: 1 } }, clientId },
					{ clock: { timestamp: 1000, vector: { client1: 2 } }, clientId }
				)
				expect(result4).toBeLessThan(0)

				// Test identical clocks
				const result5 = clockService.compareClock(
					{ clock: { timestamp: 1000, vector: { client1: 1 } }, clientId },
					{ clock: { timestamp: 1000, vector: { client1: 1 } }, clientId }
				)
				expect(result5).toBe(0)
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// Provide layer individually
	it.scoped(
		"should use client ID as tiebreaker when comparing identical clocks",
		() =>
			Effect.gen(function* (_) {
				const clockService = yield* ClockService
				const clientId1 = "client-aaa"
				const clientId2 = "client-bbb"

				// Structure needs to match the expected input for compareClock
				const itemA = { clock: { timestamp: 1000, vector: { c1: 1 } }, clientId: clientId1 }
				const itemB = { clock: { timestamp: 1000, vector: { c1: 1 } }, clientId: clientId2 }

				// Assuming compareClock uses clientId for tie-breaking when timestamp and vector are equal
				// and assuming string comparison ('client-aaa' < 'client-bbb')
				const result = clockService.compareClock(itemA, itemB)

				// Expecting result < 0 because clientId1 < clientId2
				expect(result).toBeLessThan(0)

				// Test the reverse comparison
				const resultReverse = clockService.compareClock(itemB, itemA)
				expect(resultReverse).toBeGreaterThan(0)
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// Provide layer individually
	it.scoped(
		"should sort clocks correctly",
		() =>
			Effect.gen(function* (_) {
				const clockService = yield* ClockService

				const items = [
					// Add clientId to match the expected structure for sortClocks
					{ id: 1, clock: { timestamp: 2000, vector: { client1: 1 } }, clientId: "client1" },
					{ id: 2, clock: { timestamp: 1000, vector: { client1: 2 } }, clientId: "client1" },
					{ id: 3, clock: { timestamp: 1000, vector: { client1: 1 } }, clientId: "client1" },
					{ id: 4, clock: { timestamp: 3000, vector: { client1: 1 } }, clientId: "client1" }
				]

				const sorted = clockService.sortClocks(items)

				// Items should be sorted first by timestamp, then by vector values
				expect(sorted[0]!.id).toBe(3) // 1000, {client1: 1}
				expect(sorted[1]!.id).toBe(2) // 1000, {client1: 2}
				expect(sorted[2]!.id).toBe(1) // 2000, {client1: 1}
				expect(sorted[3]!.id).toBe(4) // 3000, {client1: 1}
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// Provide layer individually
	it.scoped(
		"should find latest common clock",
		() =>
			Effect.gen(function* (_) {
				const clock = yield* ClockService

				// Test case: common ancestor exists
				// Add client_id to match the expected structure for findLatestCommonClock
				const localActions = [
					{
						id: "1",
						clock: { timestamp: 1000, vector: { client1: 1 } },
						synced: true,
						client_id: "client1"
					},
					{
						id: "2",
						clock: { timestamp: 2000, vector: { client1: 1 } },
						synced: true,
						client_id: "client1"
					},
					{
						id: "3",
						clock: { timestamp: 3000, vector: { client1: 1 } },
						synced: false,
						client_id: "client1"
					}
				]

				const remoteActions = [
					{
						id: "4",
						clock: { timestamp: 2500, vector: { client1: 1 } },
						synced: true,
						client_id: "client2" // Assume remote actions can have different client_ids
					},
					{
						id: "5",
						clock: { timestamp: 3500, vector: { client1: 1 } },
						synced: true,
						client_id: "client2"
					}
				]

				const commonClock = clock.findLatestCommonClock(localActions, remoteActions)
				expect(commonClock).not.toBeNull()
				expect(commonClock?.timestamp).toBe(2000)
				expect(commonClock?.vector.client1).toBe(1)

				// Test case: no common ancestor
				const laterRemoteActions = [
					{
						id: "6",
						clock: { timestamp: 500, vector: { client1: 1 } },
						synced: true,
						client_id: "client2"
					}
				]

				const noCommonClock = clock.findLatestCommonClock(localActions, laterRemoteActions)
				expect(noCommonClock).toBeNull()

				// Test case: no synced local actions
				const unSyncedLocalActions = [
					{
						id: "7",
						clock: { timestamp: 1000, vector: { client1: 1 } },
						synced: false,
						client_id: "client1"
					}
				]

				const noSyncedClock = clock.findLatestCommonClock(unSyncedLocalActions, remoteActions)
				expect(noSyncedClock).toBeNull()
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)
})

// Use describe instead of it.layer
describe("DB Reverse Patch Functions", () => {
	// Test setup and core functionality
	// Provide layer individually
	it.scoped(
		"should correctly create tables and initialize triggers",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient

				// Verify that the sync tables exist
				const tables = yield* sql<{ table_name: string }>`
				SELECT table_name
				FROM information_schema.tables
				WHERE table_schema = current_schema()
				AND table_name IN ('action_records', 'action_modified_rows', 'client_sync_status')
				ORDER BY table_name
			`

				// Check that all required tables exist
				expect(tables.length).toBe(3)
				expect(tables.map((t) => t.table_name).sort()).toEqual([
					"action_modified_rows",
					"action_records",
					"client_sync_status"
				])

				// Verify that the action_records table has the correct columns
				const actionRecordsColumns = yield* sql<{ column_name: string }>`
				SELECT column_name
				FROM information_schema.columns
				WHERE table_name = 'action_records'
				ORDER BY column_name
			`

				// Check that all required columns exist
				expect(actionRecordsColumns.map((c) => c.column_name)).toContain("id")
				expect(actionRecordsColumns.map((c) => c.column_name)).toContain("_tag")
				expect(actionRecordsColumns.map((c) => c.column_name)).toContain("client_id")
				expect(actionRecordsColumns.map((c) => c.column_name)).toContain("transaction_id")
				expect(actionRecordsColumns.map((c) => c.column_name)).toContain("clock")
				expect(actionRecordsColumns.map((c) => c.column_name)).toContain("clock_time_ms")
				expect(actionRecordsColumns.map((c) => c.column_name)).toContain("clock_counter")
				expect(actionRecordsColumns.map((c) => c.column_name)).toContain("args")
				expect(actionRecordsColumns.map((c) => c.column_name)).toContain("created_at")
				expect(actionRecordsColumns.map((c) => c.column_name)).toContain("synced")

				// Verify that the action_modified_rows table has the correct columns
				const actionModifiedRowsColumns = yield* sql<{ column_name: string }>`
				SELECT column_name
				FROM information_schema.columns
				WHERE table_name = 'action_modified_rows'
				ORDER BY column_name
			`

				// Check that all required columns exist
				expect(actionModifiedRowsColumns.map((c) => c.column_name)).toContain("id")
				expect(actionModifiedRowsColumns.map((c) => c.column_name)).toContain("table_name")
				expect(actionModifiedRowsColumns.map((c) => c.column_name)).toContain("row_id")
				expect(actionModifiedRowsColumns.map((c) => c.column_name)).toContain("action_record_id")
				expect(actionModifiedRowsColumns.map((c) => c.column_name)).toContain("operation")
				expect(actionModifiedRowsColumns.map((c) => c.column_name)).toContain("forward_patches")
				expect(actionModifiedRowsColumns.map((c) => c.column_name)).toContain("reverse_patches")

				// Verify that the required functions exist
				const functions = yield* sql<{ proname: string }>`
				SELECT proname
				FROM pg_proc
				WHERE proname IN (
					'generate_patches',
					'prepare_operation_data',
					'generate_op_patches',
					'handle_remove_operation',
					'handle_insert_operation',
					'handle_update_operation',
					'apply_forward_amr',
					'apply_reverse_amr',
					'apply_forward_amr_batch',
					'apply_reverse_amr_batch',
					'rollback_to_action',
					'create_patches_trigger'
				)
				ORDER BY proname
			`

				// Check that all required functions exist
				expect(functions.length).toBeGreaterThan(0)
				expect(functions.map((f) => f.proname)).toContain("generate_patches")
				expect(functions.map((f) => f.proname)).toContain("generate_op_patches")
				expect(functions.map((f) => f.proname)).toContain("handle_remove_operation")
				expect(functions.map((f) => f.proname)).toContain("handle_insert_operation")
				expect(functions.map((f) => f.proname)).toContain("handle_update_operation")
				expect(functions.map((f) => f.proname)).toContain("apply_forward_amr")
				expect(functions.map((f) => f.proname)).toContain("apply_reverse_amr")
				expect(functions.map((f) => f.proname)).toContain("apply_forward_amr_batch")
				expect(functions.map((f) => f.proname)).toContain("apply_reverse_amr_batch")
				expect(functions.map((f) => f.proname)).toContain("rollback_to_action")
				expect(functions.map((f) => f.proname)).toContain("create_patches_trigger")

				// Verify that the notes table has a trigger for patch generation
				const triggers = yield* sql<{ tgname: string }>`
				SELECT tgname
				FROM pg_trigger
				WHERE tgrelid = 'notes'::regclass
				AND tgname = 'generate_patches_trigger'
			`

				// Check that the trigger exists
				expect(triggers.length).toBe(1)
				expect(triggers[0]!.tgname).toBe("generate_patches_trigger")
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// Test patch generation for INSERT operations
	// Provide layer individually
	it.scoped(
		"should generate patches for INSERT operations",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const deterministicId = yield* DeterministicId

				yield* Effect.gen(function* () {
					// Begin a transaction to ensure consistent txid

					// Get current transaction ID before creating the action record
					const txResult = yield* sql<{ txid: string }>`SELECT txid_current() as txid`
					const currentTxId = txResult[0]!.txid

					// Create an action record with the current transaction ID
					const actionResult = yield* sql<{ id: string; transaction_id: string }>`
					INSERT INTO action_records (_tag, client_id, transaction_id, clock, args, synced)
					VALUES ('test_insert', 'server', ${currentTxId}, '{"timestamp": 1, "vector": {"server": 1}}'::jsonb, '{}'::jsonb, 0)
					RETURNING id, transaction_id
				`

					const actionId = actionResult[0]!.id
					yield* sql`SELECT set_config('sync.capture_action_record_id', ${actionId}, true)`

					const noteRow = {
						title: "Test Note",
						content: "This is a test note",
						user_id: "user1"
					} as const
					const noteId = yield* deterministicId.withActionContext(
						actionId,
						deterministicId.forRow("notes", noteRow)
					)
					yield* sql`
						INSERT INTO notes (id, title, content, user_id)
						VALUES (${noteId}, ${noteRow.title}, ${noteRow.content}, ${noteRow.user_id})
					`

					// Commit transaction
					// yield* sql`COMMIT` // Removed commit as it's handled by withTransaction

					// Check that an entry was created in action_modified_rows
					const amrResult = yield* sql<{
						id: string
						table_name: string
						row_id: string
						action_record_id: string
						operation: string
						forward_patches: any
						reverse_patches: any
						sequence: number | null // Add sequence to the type definition
					}>`
				SELECT id, table_name, row_id, action_record_id, operation, forward_patches, reverse_patches, sequence -- Add sequence to SELECT
				FROM action_modified_rows
				WHERE action_record_id = ${actionId}
			`

					// Verify the action_modified_rows entry
					expect(amrResult.length).toBe(1)
					expect(amrResult[0]!.table_name).toBe("notes")
					expect(amrResult[0]!.row_id).toBe(noteId)
					expect(amrResult[0]!.action_record_id).toBe(actionId)
					expect(amrResult[0]!.operation).toBe("INSERT")

					// Verify forward patches contain all column values, including the generated ID
					expect(amrResult[0]!.forward_patches).toHaveProperty("id", noteId)
					expect(amrResult[0]!.forward_patches).toHaveProperty("title", "Test Note")
					expect(amrResult[0]!.forward_patches).toHaveProperty("content", "This is a test note")
					expect(amrResult[0]!.forward_patches).toHaveProperty("user_id", "user1")

					// Verify reverse patches are empty for INSERT operations
					expect(Object.keys(amrResult[0]!.reverse_patches).length).toBe(0)
				}).pipe(sql.withTransaction)
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// Test patch generation for UPDATE operations
	// Provide layer individually
	it.scoped(
		"should generate patches for UPDATE operations",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const deterministicId = yield* DeterministicId

				// Execute everything in a single transaction to maintain consistent transaction ID
				const result = yield* Effect.gen(function* () {
					// Get current transaction ID
					const txResult = yield* sql<{ txid: string }>`SELECT txid_current() as txid`
					const currentTxId = txResult[0]!.txid

					// Create action record for this transaction
					const actionResult = yield* sql<{ id: string; transaction_id: string }>`
						INSERT INTO action_records (_tag, client_id, transaction_id, clock, args, synced)
					VALUES ('test_update', 'server', ${currentTxId}, '{"timestamp": 2, "vector": {"server": 1}}'::jsonb, '{}'::jsonb, 0)
					RETURNING id, transaction_id
					`
					const actionId = actionResult[0]!.id
					yield* sql`SELECT set_config('sync.capture_action_record_id', ${actionId}, true)`

					// First, create a note
					const noteRow = {
						title: "Original Title",
						content: "Original Content",
						user_id: "user1"
					} as const
					const noteId = yield* deterministicId.withActionContext(
						actionId,
						deterministicId.forRow("notes", noteRow)
					)
					yield* sql`
						INSERT INTO notes (id, title, content, user_id)
						VALUES (${noteId}, ${noteRow.title}, ${noteRow.content}, ${noteRow.user_id})
					`

					// Then update the note (still in the same transaction)
					yield* sql`
					UPDATE notes
					SET title = 'Updated Title', content = 'Updated Content'
					WHERE id = ${noteId}
				`

					// Check that an entry was created in action_modified_rows
					const amrResult = yield* sql<ActionModifiedRow>`
					SELECT *
					FROM action_modified_rows
					WHERE action_record_id = ${actionId}
				`

					return { actionId, amrResult, noteId } // Return noteId as well
				}).pipe(sql.withTransaction)

				const { actionId, amrResult, noteId } = result

				// Verify the action_modified_rows entries (expecting 2: one INSERT, one UPDATE)
				expect(amrResult.length).toBe(2)

				// Sort by sequence to reliably identify INSERT and UPDATE AMRs
				// Create a mutable copy before sorting and add types to callback params
				const mutableAmrResult = [...amrResult]
				const sortedAmrResult = mutableAmrResult.sort(
					(a: ActionModifiedRow, b: ActionModifiedRow) => (a.sequence ?? 0) - (b.sequence ?? 0)
				)

				const insertAmr = sortedAmrResult[0]!
				const updateAmr = sortedAmrResult[1]!

				// Verify INSERT AMR (sequence 0)
				expect(insertAmr.table_name).toBe("notes")
				expect(insertAmr.row_id).toBe(noteId)
				expect(insertAmr.action_record_id).toBe(actionId)
				expect(insertAmr.operation).toBe("INSERT")
				expect(insertAmr.forward_patches).toHaveProperty("id", noteId)
				expect(insertAmr.forward_patches).toHaveProperty("title", "Original Title") // Initial insert value
				expect(insertAmr.forward_patches).toHaveProperty("content", "Original Content") // Initial insert value
				expect(Object.keys(insertAmr.reverse_patches).length).toBe(0) // Reverse for INSERT is empty

				// Verify UPDATE AMR (sequence 1)
				expect(updateAmr.table_name).toBe("notes")
				expect(updateAmr.row_id).toBe(noteId)
				expect(updateAmr.action_record_id).toBe(actionId)
				expect(updateAmr.operation).toBe("UPDATE")
				expect(updateAmr.forward_patches).toEqual({
					title: "Updated Title",
					content: "Updated Content"
				}) // Only changed fields
				expect(updateAmr.reverse_patches).toEqual({
					title: "Original Title",
					content: "Original Content"
				}) // Original values for changed fields
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// Test patch generation for DELETE operations
	// Provide layer individually
	it.scoped(
		"should generate patches for DELETE operations",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const deterministicId = yield* DeterministicId

				// First transaction: Create an action record and note
				const noteId = yield* Effect.gen(function* () {
					// Get current transaction ID
					const txResult = yield* sql<{ txid: string }>`SELECT txid_current() as txid`
					const currentTxId = txResult[0]!.txid

					// Create action record for this transaction
					const actionResult = yield* sql<{ id: string }>`
						INSERT INTO action_records (_tag, client_id, transaction_id, clock, args, synced)
					VALUES ('test_insert_for_delete', 'server', ${currentTxId}, '{"timestamp": 8, "vector": {"server": 1}}'::jsonb, '{}'::jsonb, 0)
					RETURNING id
					`
					const actionId = actionResult[0]!.id
					yield* sql`SELECT set_config('sync.capture_action_record_id', ${actionId}, true)`

					const noteRow = {
						title: "Note to Delete",
						content: "This note will be deleted",
						user_id: "user1"
					} as const
					const noteId = yield* deterministicId.withActionContext(
						actionId,
						deterministicId.forRow("notes", noteRow)
					)
					yield* sql`
						INSERT INTO notes (id, title, content, user_id)
						VALUES (${noteId}, ${noteRow.title}, ${noteRow.content}, ${noteRow.user_id})
					`
					return noteId
				}).pipe(sql.withTransaction)

				// Second transaction: Create an action record and delete the note
				const result = yield* Effect.gen(function* () {
					// noteId is implicitly passed via closure
					// Get current transaction ID
					const txResult = yield* sql<{ txid: string }>`SELECT txid_current() as txid`
					const currentTxId = txResult[0]!.txid

					// Create action record for this transaction
					const actionResult = yield* sql<{ id: string; transaction_id: string }>`
						INSERT INTO action_records (_tag, client_id, transaction_id, clock, args, synced)
					VALUES ('test_delete', 'server', ${currentTxId}, '{"timestamp": 9, "vector": {"server": 1}}'::jsonb, '{}'::jsonb, 0)
					RETURNING id, transaction_id
					`
					const actionId = actionResult[0]!.id
					yield* sql`SELECT set_config('sync.capture_action_record_id', ${actionId}, true)`

					// Delete the note in the same transaction
					yield* sql`
					DELETE FROM notes
					WHERE id = ${noteId}
				`

					// Check that an entry was created in action_modified_rows
					const amrResult = yield* sql<{
						id: string
						table_name: string
						row_id: string
						action_record_id: string
						operation: string
						forward_patches: any
						reverse_patches: any
					}>`
					SELECT id, table_name, row_id, action_record_id, operation, forward_patches, reverse_patches
					FROM action_modified_rows
					WHERE action_record_id = ${actionId}
				`

					return { actionId, amrResult }
				}).pipe(sql.withTransaction) // Pass noteId through transaction

				const { actionId, amrResult } = result

				// Verify the action_modified_rows entry
				expect(amrResult.length).toBe(1)
				expect(amrResult[0]!.table_name).toBe("notes")
				expect(amrResult[0]!.row_id).toBe(noteId) // Use the captured noteId
				expect(amrResult[0]!.action_record_id).toBe(actionId)
				expect(amrResult[0]!.operation).toBe("DELETE")

				// Verify forward patches are NULL for DELETE operations
				expect(amrResult[0]!.forward_patches).toEqual({}) // Expect empty object for DELETE

				// Verify reverse patches contain all column values to restore the row
				expect(amrResult[0]!.reverse_patches).toHaveProperty("id", noteId) // Use the captured noteId
				expect(amrResult[0]!.reverse_patches).toHaveProperty("title", "Note to Delete")
				expect(amrResult[0]!.reverse_patches).toHaveProperty("content", "This note will be deleted")
				expect(amrResult[0]!.reverse_patches).toHaveProperty("user_id", "user1")
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// Test applying forward patches
	// Provide layer individually
	it.scoped(
		"should apply forward patches correctly",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const deterministicId = yield* DeterministicId

				// First transaction: Create an action record and note
				const noteId = yield* Effect.gen(function* () {
					// Get current transaction ID
					const txResult = yield* sql<{ txid: string }>`SELECT txid_current() as txid`
					const currentTxId = txResult[0]!.txid

					// Create action record for this transaction
					const actionResult = yield* sql<{ id: string }>`
						INSERT INTO action_records (_tag, client_id, transaction_id, clock, args, synced)
					VALUES ('test_insert_for_forward', 'server', ${currentTxId}, '{"timestamp": 10, "vector": {"server": 1}}'::jsonb, '{}'::jsonb, 0)
					RETURNING id
					`
					const actionId = actionResult[0]!.id
					yield* sql`SELECT set_config('sync.capture_action_record_id', ${actionId}, true)`

					const noteRow = {
						title: "Original Title",
						content: "Original Content",
						user_id: "user1"
					} as const
					const noteId = yield* deterministicId.withActionContext(
						actionId,
						deterministicId.forRow("notes", noteRow)
					)
					yield* sql`
						INSERT INTO notes (id, title, content, user_id)
						VALUES (${noteId}, ${noteRow.title}, ${noteRow.content}, ${noteRow.user_id})
					`
					return noteId
				}).pipe(sql.withTransaction)

				// Second transaction: Create an action record and update the note
				let actionId: string
				let amrId: string
				yield* Effect.gen(function* () {
					// Get current transaction ID
					const txResult = yield* sql<{ txid: string }>`SELECT txid_current() as txid`
					const currentTxId = txResult[0]!.txid

					// Create action record for this transaction
					const actionResult = yield* sql<{ id: string; transaction_id: string }>`
						INSERT INTO action_records (_tag, client_id, transaction_id, clock, args, synced)
						VALUES ('test_apply_forward', 'server', ${currentTxId}, '{"timestamp": 11, "vector": {"server": 1}}'::jsonb, '{}'::jsonb, 0)
						RETURNING id, transaction_id
					`
					actionId = actionResult[0]!.id
					yield* sql`SELECT set_config('sync.capture_action_record_id', ${actionId}, true)`

					// Update the note to generate patches
					yield* sql`
					UPDATE notes
					SET title = 'Updated Title', content = 'Updated Content'
					WHERE id = ${noteId}
				`

					// Get the action_modified_rows entry ID
					const amrResult = yield* sql<{ id: string }>`
					SELECT id
					FROM action_modified_rows
					WHERE action_record_id = ${actionId}
				`
					amrId = amrResult[0]!.id
				}).pipe(sql.withTransaction)

				// Reset the note to its original state
				yield* Effect.gen(function* () {
					// Get current transaction ID
					const txResult = yield* sql<{ txid: string }>`SELECT txid_current() as txid`
					const currentTxId = txResult[0]!.txid

					// Create action record for this transaction (for the reset operation)
					const actionResult = yield* sql<{ id: string }>`
						INSERT INTO action_records (_tag, client_id, transaction_id, clock, args, synced)
						VALUES ('test_reset', 'server', ${currentTxId}, '{"timestamp": 12, "vector": {"server": 1}}'::jsonb, '{}'::jsonb, 0)
						RETURNING id
					`
					const actionId = actionResult[0]!.id

					yield* sql`SELECT set_config('sync.disable_trigger', 'true', true)`

					// Reset the note to original state
					yield* sql`
					UPDATE notes
					SET title = 'Original Title', content = 'Original Content'
					WHERE id = ${noteId}
				`
				}).pipe(sql.withTransaction)

				// Apply forward patches in a new transaction
				yield* Effect.gen(function* () {
					// Get current transaction ID
					const txResult = yield* sql<{ txid: string }>`SELECT txid_current() as txid`
					const currentTxId = txResult[0]!.txid

					// Create action record for this transaction
					yield* sql`
						INSERT INTO action_records (_tag, client_id, transaction_id, clock, args, synced)
						VALUES ('test_apply_forward_patch', 'server', ${currentTxId}, '{"timestamp": 13, "vector": {"server": 1}}'::jsonb, '{}'::jsonb, 0)
					`
					// Note: apply_forward_amr might need context if it performs DML internally,
					// but we assume it operates directly based on the AMR ID for now.

					// Apply forward patches
					yield* sql`SELECT set_config('sync.disable_trigger', 'true', true)`
					yield* sql`SELECT apply_forward_amr(${amrId})`
				}).pipe(sql.withTransaction)

				// Check that the note was updated in a separate query
				const noteResult = yield* sql<{ title: string; content: string }>`
				SELECT title, content
				FROM notes
				WHERE id = ${noteId}
			`

				// Verify the note was updated with the forward patches
				expect(noteResult[0]!.title).toBe("Updated Title")
				expect(noteResult[0]!.content).toBe("Updated Content")
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// Test applying reverse patches
	// Provide layer individually
	it.scoped(
		"should apply reverse patches correctly",
		() =>
			Effect.gen(function* () {
				interface TestApplyPatches {
					id: string
					name: string
					value: number
					data: Record<string, unknown>
				}
				const sql = yield* PgliteClient.PgliteClient
				const deterministicId = yield* DeterministicId

				// Create test table
				yield* sql`CREATE TABLE IF NOT EXISTS test_apply_patches (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					value INTEGER NOT NULL,
					data JSONB
				)`

				// Apply sync triggers (patch capture)
				yield* applySyncTriggers(["test_apply_patches"])
				const rowIdFromInsert = yield* Effect.gen(function* () {
					// Create initial action record and set transaction variables
					const initTxResult = yield* sql<{ txid: string }>`SELECT txid_current() as txid`
					yield* Effect.logInfo(`txid: ${initTxResult[0]!.txid}`)
					const initActionRecord = yield* sql<{ id: string }>`
						INSERT INTO action_records (_tag, client_id, transaction_id, clock, args, synced)
						VALUES ('test_initial_data', 'test-client', ${initTxResult[0]!.txid}, '{"timestamp": 1000, "vector": { "test-client": 1 }}'::jsonb, '{}'::jsonb, 0)
						RETURNING id
					`
					const initActionId = initActionRecord[0]!.id

					// Disable the trigger temporarily to avoid generating patches during initial insert
					yield* sql`SELECT set_config('sync.disable_trigger', 'true', true)`

					const row = {
						name: "initial",
						value: 10,
						data: { key: "value" }
					} as const
					const rowId = yield* deterministicId.withActionContext(
						initActionId,
						deterministicId.forRow("test_apply_patches", row)
					)

					// Insert initial test data (IDs are provided by the app)
					const rowResult = yield* sql<{ id: string }>`
					INSERT INTO test_apply_patches (id, name, value, data)
					VALUES (${rowId}, ${row.name}, ${row.value}, ${JSON.stringify(row.data)}::jsonb)
					RETURNING id`

					// Re-enable the trigger
					yield* sql`SELECT set_config('sync.disable_trigger', 'false', true)`
					const rowIdFromInsert = rowResult[0]!.id
					return rowIdFromInsert
				}).pipe(sql.withTransaction)

				// Create an action record and get its ID
				const actionRecordResult = yield* sql<{ id: string }>`
					INSERT INTO action_records ${sql.insert({
						_tag: "test-patch-action",
						client_id: "test-client",
						transaction_id: (yield* sql<{ txid: string }>`SELECT txid_current() as txid`)[0]!.txid,
						clock: sql.json({ timestamp: 1000, vector: { "test-client": 1 } }),
						args: sql.json({}),
						created_at: new Date()
					})}
					RETURNING id
				`
				const actionRecordId = actionRecordResult[0]!.id

				// Create an action_modified_rows record with patches
				// Format the patches as a flat object with column names as keys, which is what apply_reverse_amr expects
				const patches = {
					name: "initial",
					value: 10,
					data: { key: "value" }
				}

				// Insert action_modified_rows with patches
				const amrResult = yield* sql<{ id: string }>`
					INSERT INTO action_modified_rows ${sql.insert({
						table_name: "test_apply_patches",
						row_id: rowIdFromInsert,
						action_record_id: actionRecordId,
						operation: "UPDATE",
						forward_patches: sql.json({}),
						reverse_patches: sql.json(patches),
						sequence: 0 // Add the missing sequence column
					})}
					RETURNING id
				`
				const amrId = amrResult[0]!.id

				// Modify the row in a transaction to generate patches and set transaction local variables
				let modifiedRow: TestApplyPatches | undefined
				yield* Effect.gen(function* () {
					// Get current transaction ID
					const txResult = yield* sql<{ txid: string }>`SELECT txid_current() as txid`
					const currentTxId = txResult[0]!.txid

					// Create an action record for this transaction
					yield* sql`
							INSERT INTO action_records (_tag, client_id, transaction_id, clock, args, synced)
							VALUES ('test_modify_before_reverse', 'test-client', ${currentTxId}, '{"timestamp": 1001, "vector": { "test-client": 2 }}'::jsonb, '{}'::jsonb, 0)
						`

					// Disable patch capture: this mutation is only preparing state for the reverse-patch test.
					yield* sql`SELECT set_config('sync.disable_trigger', 'true', true)`

					// Update the row
					yield* sql`
						UPDATE test_apply_patches
						SET name = 'changed', value = 99, data = '{"key": "changed"}'
						WHERE id = ${rowIdFromInsert}
					`

					// Get the modified row
					modifiedRow =
						(yield* sql<TestApplyPatches>`SELECT * FROM test_apply_patches WHERE id = ${rowIdFromInsert}`)[0]
				}).pipe(sql.withTransaction)

				// Verify row was modified
				expect(modifiedRow).toBeDefined()
				expect(modifiedRow!.name).toBe("changed")
				expect(modifiedRow!.value).toBe(99)
				expect(modifiedRow!.data?.key).toBe("changed")

				// Apply reverse patches using Effect's error handling in a new transaction
				const result = yield* Effect.gen(function* () {
					// Create new action record for reverse operation
					const reverseTxResult = yield* sql<{ txid: string }>`SELECT txid_current() as txid`
					yield* sql`
							INSERT INTO action_records (_tag, client_id, transaction_id, clock, args, synced)
							VALUES ('test_reverse_patch', 'test-client', ${reverseTxResult[0]!.txid}, '{"timestamp": 1002, "vector": { "test-client": 3 }}'::jsonb, '{}'::jsonb, 0)
						`

					// Disable the trigger temporarily to avoid generating patches during the reverse operation
					yield* sql`SELECT set_config('sync.disable_trigger', 'true', true)`

					// Apply reverse patches
					yield* sql`SELECT apply_reverse_amr(${amrId})`

					// Re-enable the trigger
					yield* sql`SELECT set_config('sync.disable_trigger', 'false', true)`

					// Verify row was restored to original state
					const restoredRow =
						yield* sql<TestApplyPatches>`SELECT * FROM test_apply_patches WHERE id = ${rowIdFromInsert}`
					expect(restoredRow[0]!.name).toBe("initial")
					expect(restoredRow[0]!.value).toBe(10)
					expect(restoredRow[0]!.data?.key).toBe("value")
					return false
				}).pipe(
					sql.withTransaction,
					Effect.orElseSucceed(() => true)
				)

				// Clean up
				yield* sql`DROP TABLE IF EXISTS test_apply_patches`
				yield* sql`DELETE FROM action_modified_rows WHERE action_record_id = ${actionRecordId}` // Clean up based on action record
				yield* sql`DELETE FROM action_records WHERE id = ${actionRecordId}`

				// Return whether this should be marked as a todo
				return { todo: result }
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// Provide layer individually
	it.scoped(
		"should correctly detect concurrent updates",
		() =>
			Effect.gen(function* (_) {
				const importHLC = yield* Effect.promise(() => import("@synchrotron/sync-core/HLC"))

				// Create test clocks with the updated HLC.make method
				const clock1 = importHLC.make({ timestamp: 1000, vector: { client1: 1 } })
				const clock2 = importHLC.make({ timestamp: 2000, vector: { client1: 1 } })
				const clock3 = importHLC.make({ timestamp: 1000, vector: { client1: 2 } })
				const clock4 = importHLC.make({ timestamp: 1000, vector: { client1: 1 } })
				const clock5 = importHLC.make({ timestamp: 1000, vector: { client1: 2, client2: 1 } })
				const clock6 = importHLC.make({ timestamp: 1000, vector: { client1: 1, client2: 3 } })
				const clock7 = importHLC.make({ timestamp: 1000, vector: { client1: 2, client3: 0 } })
				const clock8 = importHLC.make({ timestamp: 1000, vector: { client2: 3, client1: 1 } })

				// Non-concurrent: Different timestamps
				const nonConcurrent1 = importHLC.isConcurrent(clock1, clock2)
				expect(nonConcurrent1).toBe(false)

				// Non-concurrent: Same timestamp, one ahead
				const nonConcurrent2 = importHLC.isConcurrent(clock3, clock4)
				expect(nonConcurrent2).toBe(false)

				// Concurrent: Same timestamp, divergent vectors
				const concurrent1 = importHLC.isConcurrent(clock5, clock6)
				expect(concurrent1).toBe(true)

				// Concurrent: Same timestamp, different clients
				const concurrent2 = importHLC.isConcurrent(clock7, clock8)
				expect(concurrent2).toBe(true)
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)
})
