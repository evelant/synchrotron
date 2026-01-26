import { Model, SqlClient, SqlSchema } from "@effect/sql"
import { Effect, Schema } from "effect"
import { Todo } from "./schema"

export class TodoRepo extends Effect.Service<TodoRepo>()("TodoRepo", {
	effect: Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		const repo = yield* Model.makeRepository(Todo, {
			tableName: "todos",
			spanPrefix: "TodoRepo",
			idColumn: "id"
		})

		const findAll = SqlSchema.findAll({
			Request: Schema.Void,
			Result: Todo,
			execute: () => sql`SELECT * FROM todos ORDER BY text ASC, id ASC`
		})

		return {
			...repo,
			findAll
		} as const
	}),
	dependencies: []
}) {}
