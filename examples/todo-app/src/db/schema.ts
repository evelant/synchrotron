import { Model } from "@effect/sql"
import { Schema } from "effect"
export { ActionRecord, ActionModifiedRow } from "@synchrotron/sync-core" // Re-export directly

export class Todo extends Model.Class<Todo>("todos")({
  id: Model.Generated(Schema.UUID),
  text: Schema.String,
  completed: Schema.Boolean,
  owner_id: Schema.String,
}) {}
