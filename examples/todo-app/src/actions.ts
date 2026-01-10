import { Effect, Option, Array, Schema } from "effect"
import { ActionRegistry } from "@synchrotron/sync-core"
import { DeterministicId } from "@synchrotron/sync-core"
import { TodoRepo } from "./db/repositories"
import { Todo } from "./db/schema"
import { SqlClient } from "@effect/sql"

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
        owner_id: Schema.String,
        text: Schema.String,
      }),
      (args) =>
        Effect.gen(function* () {
          const row = {
            text: args.text,
            completed: false,
            owner_id: args.owner_id,
          } as const

          const id = yield* deterministicId.forRow("todos", row)
          yield* todoRepo.insert({ id, ...row })
        })
    )

    const toggleTodoCompletionAction = registry.defineAction(
      "ToggleTodoCompletion",
      Schema.Struct({
        timestamp: Schema.Number,
        id: Schema.String,
      }),
      (args) =>
        Effect.gen(function* () {
          const result =
            yield* sql<Todo>`SELECT * FROM todos WHERE id = ${args.id}`
          const todo = Array.head(result)

          yield* Option.match(todo, {
            onNone: () =>
              Effect.logWarning(`Todo not found for toggle: ${args.id}`),
            onSome: (t: Todo) =>
              todoRepo.update({ ...t, completed: !t.completed }),
          })
        })
    )

    const updateTodoTextAction = registry.defineAction(
      "UpdateTodoText",
      Schema.Struct({
        timestamp: Schema.Number,
        id: Schema.String,
        text: Schema.String,
      }),
      (args) =>
        Effect.gen(function* () {
          const result =
            yield* sql<Todo>`SELECT * FROM todos WHERE id = ${args.id}`
          const todo = Array.head(result)

          yield* Option.match(todo, {
            onNone: () =>
              Effect.logWarning(`Todo not found for text update: ${args.id}`),
            onSome: (t: Todo) => todoRepo.update({ ...t, text: args.text }),
          })
        })
    )

    const deleteTodoAction = registry.defineAction(
      "DeleteTodo",
      Schema.Struct({
        timestamp: Schema.Number,
        id: Schema.String,
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
        owner_id: Schema.String,
      }),
      (args) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM todos WHERE completed = ${true} AND owner_id = ${args.owner_id}`
        })
    )

    return {
      createTodoAction,
      toggleTodoCompletionAction,
      updateTodoTextAction,
      deleteTodoAction,
      clearCompletedTodosAction,
    } as const
  }),
  dependencies: [ActionRegistry.Default, TodoRepo.Default],
}) {}
