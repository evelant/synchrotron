import { SqlClient } from "@effect/sql" // Import Model
import { PgLiteClient } from "@effect/sql-pglite/PgLiteClient"
import { ActionRegistry } from "@synchrotron/sync-core/ActionRegistry" // Corrected Import
import { ClockService } from "@synchrotron/sync-core/ClockService"
import { DeterministicId } from "@synchrotron/sync-core/DeterministicId"
import { Effect, Option, Schema } from "effect" // Import DateTime
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
		const deterministicId = yield* DeterministicId

		const noteRepo = yield* createNoteRepo().pipe(Effect.provideService(SqlClient.SqlClient, sql))

		const createNoteAction = actionRegistry.defineAction(
			"test-create-note",
			Schema.Struct({
				title: Schema.String,
				content: Schema.String,
				user_id: Schema.String,
				tags: Schema.optional(Schema.Array(Schema.String)),
				timestamp: Schema.Number
			}),
			(args) =>
				Effect.gen(function* () {
					yield* Effect.logInfo(`Creating note: ${JSON.stringify(args)} at ${args.timestamp}`)

					const row: {
						title: string
						content: string
						user_id: string
						updated_at: Date
						tags?: string[] | undefined
					} = {
						title: args.title,
						content: args.content,
						user_id: args.user_id,
						updated_at: new Date(args.timestamp)
					}

					if (args.tags) row.tags = Array.from(args.tags)

					const id = yield* deterministicId.forRow("notes", {
						...row,
						tags: row.tags ?? []
					})

					return yield* noteRepo.insert({ id, ...row })
				})
		)

		const updateTagsAction = actionRegistry.defineAction(
			"test-update-tags",
			Schema.Struct({ id: Schema.String, tags: Schema.Array(Schema.String), timestamp: Schema.Number }),
			(args) =>
				Effect.gen(function* () {
					const note = yield* noteRepo.findById(args.id)
					if (note._tag === "Some") {
						yield* noteRepo.updateVoid({
							...note.value,
							tags: Array.from(args.tags),
							updated_at: new Date(args.timestamp)
						})
					}
				})
		)

		const updateContentAction = actionRegistry.defineAction(
			"test-update-content",
			Schema.Struct({ id: Schema.String, content: Schema.String, timestamp: Schema.Number }),
			(args) =>
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
			Schema.Struct({ id: Schema.String, title: Schema.String, timestamp: Schema.Number }),
			(args) =>
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
			Schema.Struct({
				id: Schema.String,
				baseContent: Schema.String,
				conditionalSuffix: Schema.optional(Schema.String),
				timestamp: Schema.Number
			}),
			(args) =>
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
			Schema.Struct({ id: Schema.String, user_id: Schema.String, timestamp: Schema.Number }),
			(args) =>
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
