import { SqlClient, type SqlError } from "@effect/sql"
import { ActionRegistry } from "@synchrotron/sync-core/ActionRegistry"
import { Effect, Schema } from "effect"

/**
 * Example custom error for database operations
 */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * Example custom error for note operations
 */
export class NoteError extends Schema.TaggedError<NoteError>()("NoteError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * Define interface for a Note
 */
interface Note {
	id: string
	title: string
	content: string
	tags: string[]
	createdAt: Date
	updatedAt: Date
}

/**
 * Define args for creating a note
 */
interface CreateNoteArgs extends Record<string, unknown> {
	title: string
	content: string
	tags: string[]
	timestamp: number
}

// TypeScript interface for query results
interface QueryResult<T> {
	rows: T[]
}

/**
 * Define an action to create a new note.
 *
 * This action:
 * 1. Fetches the current state of notes
 * 2. Applies changes by creating a new note
 * 3. Automatically registers itself with the global registry
 */
export const createNote = Effect.gen(function* () {
	const registry = yield* ActionRegistry

	return registry.defineAction<
		CreateNoteArgs, // Type of action arguments
		SqlError.SqlError | NoteError, // Possible error from apply
		SqlClient.SqlClient
	>(
		// Unique tag for this action
		"notes/createNote",
		({ title, content, tags }) =>
			Effect.gen(function* () {
				const db = yield* SqlClient.SqlClient

				const id = crypto.randomUUID()
				const now = new Date()

				// Insert the new note into the database
				yield* db`INSERT INTO notes ${db.insert({ id, title, content, tags: JSON.stringify(tags), created_at: now, updated_at: now })}`
			}).pipe()
	)
})
/**
 * Usage example:
 *
 * // No need to register separately, defineAction handles that automatically
 *
 * // Create a note action
 * const myNote = createNote({
 *   title: "My New Note",
 *   content: "This is the content",
 *   tags: ["personal", "ideas"]
 * })
 *
 * // Execute the action
 * const result = yield* SyncService.executeAction(myNote, persistence)
 */

// TODO: Create example for action with more complex operations

// TODO: Add an example with data validation before executing the action
