import { SqlClient, type SqlError } from "@effect/sql"
import { ActionRegistry } from "@synchrotron/sync-core/ActionRegistry"
import { DeterministicId } from "@synchrotron/sync-core/DeterministicId"
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
	const db = yield* SqlClient.SqlClient
	const deterministicId = yield* DeterministicId

	return registry.defineAction(
		// Unique tag for this action
		"notes/createNote",
		Schema.Struct({
			title: Schema.String,
			content: Schema.String,
			tags: Schema.Array(Schema.String),
			timestamp: Schema.Number
		}),
		({ title, content, tags, timestamp }) =>
			Effect.gen(function* () {
				const now = new Date(timestamp)
				const row = { title, content, tags } as const
				const id = yield* deterministicId.forRow("notes", row)

				// Insert the new note into the database
				yield* db`INSERT INTO notes ${db.insert({
					id,
					title,
					content,
					tags: JSON.stringify(tags),
					created_at: now,
					updated_at: now
				})}`
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
