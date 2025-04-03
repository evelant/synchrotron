import { Model, SqlClient } from "@effect/sql" // Import Model
import { PgLiteClient } from "@effect/sql-pglite/PgLiteClient"
import { ActionRegistry, ActionCreator } from "@synchrotron/sync-core/ActionRegistry" // Corrected Import
import { ClockService } from "@synchrotron/sync-core/ClockService"
import { DateTime, Effect, Option } from "effect" // Import DateTime
import { createNoteRepo } from "./TestLayers"
import { Action } from "@synchrotron/sync-core/models" // Removed ActionCreator import

/**
 * TestHelpers Service for sync tests
 *
 * This service provides test actions that are scoped to a specific SQL client instance
 * making it easier to write tests that involve multiple clients with schema isolation.
 */
export class TestHelpers extends Effect.Service<TestHelpers>()("TestHelpers", {
	effect: Effect.gen(function* () {
		// Get the SQL client from the context
		const sql = yield* PgLiteClient
		const actionRegistry = yield* ActionRegistry
		const clockService = yield* ClockService // Get ClockService for client ID

		// Create a note repository for this SQL client
		const noteRepo = yield* createNoteRepo().pipe(Effect.provideService(SqlClient.SqlClient, sql))

		/**
		 * Creates a note with the given properties
		 */
		const createNoteAction = actionRegistry.defineAction(
			"test-create-note",
			(
				// Type for the apply function's args
				args: {
					id: string
					title: string
					content: string
					user_id: string
					tags?: string[]
					timestamp: number // Implementation expects timestamp
				}
			) =>
				Effect.gen(function* () {
					yield* Effect.logInfo(`Creating note: ${JSON.stringify(args)} at ${args.timestamp}`)
					// yield* sql`insert into notes ${sql.insert({
					// 	id: args.id,
					// 	title: args.title,
					// 	content: args.content,
					// 	tags: args.tags,
					// 	updated_at: args.timestamp,
					// 	user_id: args.user_id
					// })}`
					yield* noteRepo.insertVoid({
						...args, // Spread args first
						// updated_at: args.timestamp
						// Use Model.Override with DateTime for deterministic updated_at
						updated_at: Model.Override(DateTime.unsafeMake(new Date(args.timestamp))) // Reverted back
					})
				})
		)

		/**
		 * Updates the tags of a note
		 */
		const updateTagsAction = actionRegistry.defineAction(
			"test-update-tags",
			(
				args: { id: string; tags: string[]; timestamp: number } // Implementation expects timestamp
			) =>
				Effect.gen(function* () {
					const note = yield* noteRepo.findById(args.id)
					if (note._tag === "Some") {
						yield* noteRepo.updateVoid({
							...note.value,
							tags: args.tags,
							// Use Model.Override with DateTime for deterministic updated_at
							updated_at: Model.Override(DateTime.unsafeMake(new Date(args.timestamp))) // Reverted back
						})
					}
				})
		)

		/**
		 * Updates the content of a note
		 */
		const updateContentAction = actionRegistry.defineAction(
			"test-update-content",
			(
				// Type for the apply function's args
				args: {
					id: string
					content: string
					timestamp: number // Implementation expects timestamp
				}
			) =>
				Effect.gen(function* () {
					const note = yield* noteRepo.findById(args.id)
					if (note._tag === "Some") {
						yield* noteRepo.updateVoid({
							...note.value,
							content: args.content,
							// Use Model.Override with DateTime for deterministic updated_at
							updated_at: Model.Override(DateTime.unsafeMake(new Date(args.timestamp))) // Reverted back
						})
					}
				})
		)

		/**
		 * Updates the title of a note
		 */
		const updateTitleAction = actionRegistry.defineAction(
			"test-update-title",
			(
				args: { id: string; title: string; timestamp: number } // Implementation expects timestamp
			) =>
				Effect.gen(function* () {
					const note = yield* noteRepo.findById(args.id)
					if (note._tag === "Some") {
						yield* noteRepo.updateVoid({
							...note.value,
							title: args.title,
							// Use Model.Override with DateTime for deterministic updated_at
							updated_at: Model.Override(DateTime.unsafeMake(new Date(args.timestamp))) // Reverted back
						})
					}
				})
		)

		/**
		 * Updates the content of a note conditionally based on the client ID.
		 */
		const conditionalUpdateAction = actionRegistry.defineAction(
			"test-conditional-update",
			(
				// Type for the apply function's args
				args: {
					id: string
					baseContent: string
					conditionalSuffix?: string
					timestamp: number // Implementation expects timestamp
				}
			) =>
				Effect.gen(function* () {
					const clientId = yield* clockService.getNodeId
					const noteOpt = yield* noteRepo.findById(args.id)
					if (Option.isSome(noteOpt)) {
						const note = noteOpt.value
						const newContent =
							clientId === "clientA"
								? args.baseContent + (args.conditionalSuffix ?? "")
								: args.baseContent

						yield* noteRepo.updateVoid({
							...note,
							content: newContent,
							// Use Model.Override with DateTime for deterministic updated_at
							updated_at: Model.Override(DateTime.unsafeMake(new Date(args.timestamp))) // Reverted back
						})
					}
				})
		)

		/**
		 * Deletes a note
		 */
		const deleteContentAction = actionRegistry.defineAction(
			"test-delete-content",
			(
				args: { id: string; user_id: string; timestamp: number } // Implementation expects timestamp
			) =>
				Effect.gen(function* () {
					// Delete the note - updated_at is not relevant here
					yield* noteRepo.delete(args.id)
				})
		)

		return {
			createNoteAction,
			updateTagsAction,
			updateContentAction,
			updateTitleAction,
			conditionalUpdateAction,
			deleteContentAction,
			noteRepo
		}
	})
}) {}
