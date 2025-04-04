import { Effect, Option, Array } from "effect"
import { ActionRegistry } from "@synchrotron/sync-core"
import { TodoRepo } from "./db/repositories"
import { Todo } from "./db/schema"
import { SqlClient } from "@effect/sql"

type CreateTodoArgs = {
  timestamp: number
  owner_id: string
  text: string
}
type ToggleTodoArgs = {
  timestamp: number
  id: string
}
type UpdateTodoTextArgs = {
  timestamp: number
  id: string
  text: string
}
type DeleteTodoArgs = {
  timestamp: number
  id: string
}
type ClearCompletedArgs = {
  timestamp: number
  owner_id: string
}

export class TodoActions extends Effect.Service<TodoActions>()("TodoActions", {
  effect: Effect.gen(function* () {
    const registry = yield* ActionRegistry
    const todoRepo = yield* TodoRepo
    const sql = yield* SqlClient.SqlClient

    const createTodoAction = registry.defineAction(
      "CreateTodo",
      (args: CreateTodoArgs) =>
        Effect.gen(function* () {
          const { timestamp, ...insertData } = args
          yield* todoRepo.insert({
            ...insertData,
            completed: false,
          })
        })
    )

    const toggleTodoCompletionAction = registry.defineAction(
      "ToggleTodoCompletion",
      (args: ToggleTodoArgs) =>
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
      (args: UpdateTodoTextArgs) =>
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
      (args: DeleteTodoArgs) =>
        Effect.gen(function* () {
          yield* todoRepo.delete(args.id)
        })
    )

    const clearCompletedTodosAction = registry.defineAction(
      "ClearCompletedTodos",
      (args: ClearCompletedArgs) =>
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
