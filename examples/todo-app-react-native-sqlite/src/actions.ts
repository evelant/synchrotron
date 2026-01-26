import { SqlClient } from "@effect/sql"
import { ActionRegistry, DeterministicId } from "@synchrotron/sync-core"
import { Array, Effect, Option, Schema } from "effect"
import { TodoRepo } from "./db/repositories"

export class TodoActions extends Effect.Service<TodoActions>()("TodoActions", {
	effect: Effect.gen(function* () {
		const registry = yield* ActionRegistry
		const todoRepo = yield* TodoRepo
		const sql = yield* SqlClient.SqlClient
		const deterministicId = yield* DeterministicId

		const createTodoAction = registry.defineAction(
			"CreateTodo",
			Schema.Struct({
				timestamp: Schema.Number,
				project_id: Schema.String,
				created_by: Schema.String,
				text: Schema.String
			}),
			(args) =>
				Effect.gen(function* () {
					const row = {
						text: args.text,
						completed: false,
						project_id: args.project_id,
						created_by: args.created_by
					} as const

					const id = yield* deterministicId.forRow("todos", row)
					yield* todoRepo.insert({ id, ...row })
				})
		)

		const toggleTodoCompletionAction = registry.defineAction(
			"ToggleTodoCompletion",
			Schema.Struct({
				timestamp: Schema.Number,
				id: Schema.String
			}),
			(args) =>
				Effect.gen(function* () {
					const result = yield* sql<{ readonly completed: unknown }>`
						SELECT completed FROM todos WHERE id = ${args.id}
					`
					const todo = Array.head(result)
					const currentCompleted = (value: unknown): boolean =>
						value === true || value === 1 || value === "1"

					yield* Option.match(todo, {
						onNone: () => Effect.logWarning(`Todo not found for toggle: ${args.id}`),
						onSome: (t) =>
							sql<{ readonly id: string }>`
								UPDATE todos
								SET completed = ${currentCompleted(t.completed) ? 0 : 1}
								WHERE id = ${args.id}
								RETURNING id
							`
					})
				})
		)

		const updateTodoTextAction = registry.defineAction(
			"UpdateTodoText",
			Schema.Struct({
				timestamp: Schema.Number,
				id: Schema.String,
				text: Schema.String
			}),
			(args) =>
				Effect.gen(function* () {
					const result = yield* sql<{
						readonly id: string
					}>`SELECT id FROM todos WHERE id = ${args.id}`
					const todo = Array.head(result)

					yield* Option.match(todo, {
						onNone: () => Effect.logWarning(`Todo not found for text update: ${args.id}`),
						onSome: () =>
							sql<{ readonly id: string }>`
								UPDATE todos
								SET text = ${args.text}
								WHERE id = ${args.id}
								RETURNING id
							`
					})
				})
		)

		const deleteTodoAction = registry.defineAction(
			"DeleteTodo",
			Schema.Struct({
				timestamp: Schema.Number,
				id: Schema.String
			}),
			(args) =>
				Effect.gen(function* () {
					yield* todoRepo.delete(args.id)
				})
		)

		const clearCompletedTodosAction = registry.defineAction(
			"ClearCompletedTodos",
			Schema.Struct({
				timestamp: Schema.Number,
				project_id: Schema.String
			}),
			(args) =>
				Effect.gen(function* () {
					yield* sql`DELETE FROM todos WHERE completed = ${1} AND project_id = ${args.project_id}`
				})
		)

		return {
			createTodoAction,
			toggleTodoCompletionAction,
			updateTodoTextAction,
			deleteTodoAction,
			clearCompletedTodosAction
		} as const
	}),
	dependencies: [ActionRegistry.Default, TodoRepo.Default, DeterministicId.Default]
}) {}
