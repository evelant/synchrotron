import { Model, SqlClient, SqlSchema } from "@effect/sql"
import { describe, it } from "@effect/vitest" // Import describe
import { ActionRegistry } from "@synchrotron/sync-core/ActionRegistry"
import { SyncService } from "@synchrotron/sync-core/SyncService"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import { TestHelpers } from "../helpers/TestHelpers"
import { NoteModel, makeTestLayers } from "../helpers/TestLayers"

/**
 * Tests for basic action execution functionality
 *
 * These tests verify:
 * 1. Action definition and registration
 * 2. Basic action execution
 * 3. Action record creation
 * 4. Transaction handling
 * 5. Error handling
 */

// Create test repository and queries
const createNoteRepo = () =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient

		// Create the repo
		const repo = yield* Model.makeRepository(NoteModel, {
			tableName: "notes",
			idColumn: "id",
			spanPrefix: "NotesRepo"
		})

		// Create type-safe queries
		const findByTitle = SqlSchema.findAll({
			Request: Schema.String,
			Result: NoteModel,
			execute: (title) => sql`SELECT * FROM notes WHERE title = ${title}`
		})

		const findById = SqlSchema.findOne({
			Request: Schema.String,
			Result: NoteModel,
			execute: (id) => sql`SELECT * FROM notes WHERE id = ${id}`
		})

		return {
			...repo,
			findByTitle,
			findById
		} as const
	})

// Use describe instead of it.layer
describe("Basic Action Execution", () => {
	// Provide layer individually
	it.scoped(
		"should create and apply actions through the action system",
		() =>
			Effect.gen(function* () {
				// Setup
				const syncService = yield* SyncService
				const { createNoteAction, noteRepo } = yield* TestHelpers

				// Create and execute action
				const action = createNoteAction({
					title: "Test Note",
					content: "Test Content",
					user_id: "test-user"
				})

				const { actionRecord, result } = yield* syncService.executeAction(action)

				// Verify action record
				expect(actionRecord.id).toBeDefined()
				expect(actionRecord._tag).toBe("test-create-note")
				expect(actionRecord.synced).toBe(false)
				expect(actionRecord.transaction_id).toBeDefined()
				expect(actionRecord.clock).toBeDefined()

				// Verify note was created
				const note = yield* noteRepo.findById(result.id)
				expect(note._tag).toBe("Some")
				if (note._tag === "Some") {
					expect(note.value.title).toBe("Test Note")
					expect(note.value.content).toBe("Test Content")
				}
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// Provide layer individually
	it.scoped(
		"should ensure action record creation and action execution happen in a single transaction",
		() =>
			Effect.gen(function* () {
				const syncService = yield* SyncService
				const sql = yield* SqlClient.SqlClient
				const noteRepo = yield* createNoteRepo()
				const registry = yield* ActionRegistry

				const failingNoteId = "00000000-0000-4000-8000-000000000001"

				// Define an action that will fail
				const failingAction = registry.defineAction(
					"test-failing-transaction",
					Schema.Struct({ timestamp: Schema.Number }),
					(args) =>
						Effect.gen(function* () {
							// First insert a note
							yield* noteRepo.insert(
								NoteModel.insert.make({
									id: failingNoteId,
									title: "Will Fail",
									content: "This should be rolled back",
									user_id: "test-user",
									updated_at: new Date(args.timestamp)
								})
							)

							// Then fail
							return yield* Effect.fail(new Error("Intentional failure"))
						})
				)

				// Execute the failing action
				const action = failingAction({})
				const result = yield* Effect.either(syncService.executeAction(action))

				// Verify action failed
				expect(result._tag).toBe("Left")

				// Verify note was not created (rolled back)
				const note = yield* noteRepo.findById(failingNoteId)
				expect(note._tag).toBe("None")

				// Verify no action record was created
				const actionRecord = yield* sql`
					SELECT * FROM action_records
					WHERE _tag = 'test-failing-transaction'
				`
				expect(actionRecord.length).toBe(0)
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)
})
