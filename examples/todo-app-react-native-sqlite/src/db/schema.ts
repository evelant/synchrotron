import { Model } from "@effect/sql"
import { Effect, Schema } from "effect"

export { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core"

const DbBoolean = Schema.transformOrFail(
	Schema.Union(Schema.Boolean, Schema.Literal(0, 1)),
	Schema.Boolean,
	{
		decode: (value) => Effect.succeed(typeof value === "boolean" ? value : value === 1),
		encode: (value) => Effect.succeed(value ? (1 as const) : (0 as const))
	}
)

export class Todo extends Model.Class<Todo>("todos")({
	id: Schema.UUID,
	text: Schema.String,
	completed: DbBoolean,
	project_id: Schema.String,
	created_by: Schema.String,
	// Generated column (computed from `project_id`); select-only (cannot insert/update).
	audience_key: Model.FieldOnly("select")(Schema.optional(Schema.String))
}) {}
