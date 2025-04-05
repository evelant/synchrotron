import { SqlClient } from "@effect/sql" // Import Model
import { PgLiteClient } from "@effect/sql-pglite/PgLiteClient"
import { ActionRegistry } from "@synchrotron/sync-core/ActionRegistry" // Corrected Import
import { ClockService } from "@synchrotron/sync-core/ClockService"
import { Effect, Option } from "effect" // Import DateTime
import { createNoteRepo } from "./TestLayers"

/**
 * TestHelpers Service for sync tests
 *
 * This service provides test actions that are scoped to a specific SQL client instance
 * making it easier to write tests that involve multiple clients with schema isolation.
 */
export class TestHelpers extends Effect.Service<TestHelpers>()("TestHelpers", {
	effect: Effect.gen(function* () {
		const sql = yield* PgLiteClient
		const actionRegistry = yield* ActionRegistry
		const clockService = yield* ClockService

		const noteRepo = yield* createNoteRepo().pipe(Effect.provideService(SqlClient.SqlClient, sql))

		const createNoteAction = actionRegistry.defineAction(
			"test-create-note",
			(args: {
				id: string
				title: string
				content: string
				user_id: string
				tags?: string[]
				timestamp: number
			}) =>
				Effect.gen(function* () {
					yield* Effect.logInfo(`Creating note: ${JSON.stringify(args)} at ${args.timestamp}`)

					yield* noteRepo.insertVoid({
						...args,
						updated_at: new Date(args.timestamp)
					})
				})
		)

		const updateTagsAction = actionRegistry.defineAction(
			"test-update-tags",
			(args: { id: string; tags: string[]; timestamp: number }) =>
				Effect.gen(function* () {
					const note = yield* noteRepo.findById(args.id)
					if (note._tag === "Some") {
						yield* noteRepo.updateVoid({
							...note.value,
							tags: args.tags,
							updated_at: new Date(args.timestamp)
						})
					}
				})
		)

		const updateContentAction = actionRegistry.defineAction(
			"test-update-content",
			(args: { id: string; content: string; timestamp: number }) =>
				Effect.gen(function* () {
					const note = yield* noteRepo.findById(args.id)
					if (note._tag === "Some") {
						yield* noteRepo.updateVoid({
							...note.value,
							content: args.content,
							updated_at: new Date(args.timestamp)
						})
					}
				})
		)

		const updateTitleAction = actionRegistry.defineAction(
			"test-update-title",
			(args: { id: string; title: string; timestamp: number }) =>
				Effect.gen(function* () {
					const note = yield* noteRepo.findById(args.id)
					if (note._tag === "Some") {
						yield* noteRepo.updateVoid({
							...note.value,
							title: args.title,
							updated_at: new Date(args.timestamp)
						})
					}
				})
		)

		const conditionalUpdateAction = actionRegistry.defineAction(
			"test-conditional-update",
			(args: { id: string; baseContent: string; conditionalSuffix?: string; timestamp: number }) =>
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
							updated_at: new Date(args.timestamp)
						})
					}
				})
		)

		const deleteContentAction = actionRegistry.defineAction(
			"test-delete-content",
			(args: { id: string; user_id: string; timestamp: number }) =>
				Effect.gen(function* () {
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
