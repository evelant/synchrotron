import { Model } from "@effect/sql"
import { HLC } from "@synchrotron/sync-core/HLC"
import { Effect, Schema } from "effect"

/**
 * Generic Action for SyncService to apply changes
 *
 * An action needs to describe:
 * 1. A unique tag to identify the action
 * 2. A method to apply changes to the database
 * 3. Serializable arguments that capture all non-deterministic inputs to the action so that the action is pure and can be replayed on different clients with the same result
 */
export interface Action<A1, A extends Record<string, unknown>, EE, R = never> {
	/**
	 * Unique identifier for the action
	 */
	_tag: string
	/**
	 * Apply the changes to the database.
	 * Receives the original arguments plus the timestamp injected by executeAction.
	 */
	execute: () => Effect.Effect<A1, EE, R>
	/**
	 * Serializable arguments to be saved with the action for later replay
	 * This now includes the timestamp.
	 */
	args: A
}

export const PatchesSchema = Schema.Record({
	key: Schema.String,
	value: Schema.Unknown
})

export interface Patches extends Schema.Schema.Type<typeof PatchesSchema> {}

/**
 * Effect-SQL model for ActionRecord
 */
export class ActionRecord extends Model.Class<ActionRecord>("action_records")({
	id: Model.Generated(Schema.String),
	_tag: Schema.String,
	client_id: Schema.String,
	transaction_id: Schema.Number,
	clock: HLC,
	args: Schema.Struct({ timestamp: Schema.Number }, { key: Schema.String, value: Schema.Unknown }),
	created_at: Schema.Union(Schema.DateFromString, Schema.DateFromSelf),
	synced: Schema.Boolean.pipe(Schema.optionalWith({ default: () => false })),
	sortable_clock: Model.Generated(Schema.String)
}) {}

/**
 * Model for tracking client sync status
 */
export const ClientId = Schema.String.pipe(Schema.brand("sync/clientId"))
export type ClientId = typeof ClientId.Type
export class ClientSyncStatusModel extends Model.Class<ClientSyncStatusModel>("client_sync_status")(
	{
		client_id: ClientId,
		current_clock: HLC,
		last_synced_clock: HLC
	}
) {}

/**
 * Model for tracking which rows were modified by which action
 */
export class ActionModifiedRow extends Model.Class<ActionModifiedRow>("ActionModifiedRow")({
	id: Schema.String,
	table_name: Schema.String,
	row_id: Schema.String,
	action_record_id: Schema.String,
	operation: Schema.Literal("INSERT", "UPDATE", "DELETE"),
	forward_patches: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	reverse_patches: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	sequence: Schema.Number
}) {}
