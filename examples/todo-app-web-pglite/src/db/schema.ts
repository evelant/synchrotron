import { Model } from "@effect/sql"
import { Schema } from "effect"
export { ActionRecord, ActionModifiedRow } from "@synchrotron/sync-core" // Re-export directly

export class Todo extends Model.Class<Todo>("todos")({
	id: Schema.UUID,
	text: Schema.String,
	completed: Schema.Boolean,
	project_id: Schema.String,
	created_by: Schema.String,
	// Generated column (computed from `project_id`); select-only (cannot insert/update).
	audience_key: Model.FieldOnly("select")(Schema.optional(Schema.String))
}) {}
