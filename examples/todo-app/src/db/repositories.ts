import { Model } from "@effect/sql"
import { Effect } from "effect"
import { Todo } from "./schema"
import { SqlClient, SqlSchema } from "@effect/sql" // Import necessary modules
import { Schema } from "effect" // Import Schema

/**
 * Repository service for Todos
 */
export class TodoRepo extends Effect.Service<TodoRepo>()("TodoRepo", {
	effect: Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient // Get SqlClient
		const repo = yield* Model.makeRepository(Todo, {
			tableName: "todos",
			spanPrefix: "TodoRepo",
			idColumn: "id"
		})

		// Add custom queries here if needed using SqlSchema or raw sql``
		const findAll = SqlSchema.findAll({
			Request: Schema.Void, // No request parameters needed
			Result: Todo,
			execute: () => sql`SELECT * FROM todos ORDER BY id ASC` // Order by ID or another suitable column
		})

		return {
			...repo,
			findAll // Expose the new 'findAll' method
			// Add custom methods here, e.g., findByOwnerId: (...) => ...
		} as const
	}),
	dependencies: [] // SqlClient is implicitly provided via the layer
}) {}
