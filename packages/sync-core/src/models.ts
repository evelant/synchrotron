import { Model } from "@effect/sql"
import { HLC } from "@synchrotron/sync-core/HLC"
import { Effect, ParseResult, Schema } from "effect"

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
 * JSON columns are stored differently across client databases:
 * - Postgres / PGlite: JSONB values are returned as plain JS objects
 * - SQLite: JSON is typically stored as TEXT and returned as a string
 *
 * This field encodes values as JSON strings on insert/update (portable), while
 * decoding from either a JS object or a JSON string on select (portable).
 */
const JsonColumn = <S extends Schema.Schema.Any>(schema: S) =>
	Model.Field({
		select: Schema.Union(schema, Schema.parseJson(schema)),
		insert: Schema.parseJson(schema),
		update: Schema.parseJson(schema),
		json: schema,
		jsonCreate: schema,
		jsonUpdate: schema
	})

/**
 * SQLite commonly returns booleans as `0 | 1` (numbers), while Postgres returns real booleans.
 *
 * This schema decodes both representations into a boolean, while encoding booleans as `0 | 1`.
 */
const DbBoolean = Schema.transformOrFail(
	Schema.Union(Schema.Boolean, Schema.Literal(0, 1)),
	Schema.Boolean,
	{
		decode: (value) => Effect.succeed(typeof value === "boolean" ? value : value === 1),
		encode: (value) => Effect.succeed(value ? (1 as const) : (0 as const))
	}
)

/**
 * SQLite bindings (better-sqlite3 / wasm) cannot bind `Date` objects.
 * We store date-times as ISO strings in the database across client DBs.
 */
const DbDateTime = Model.Field({
	select: Schema.Union(Schema.DateFromString, Schema.DateFromSelf),
	insert: Schema.DateFromString,
	update: Schema.DateFromString,
	json: Schema.DateFromString,
	jsonCreate: Schema.DateFromString,
	jsonUpdate: Schema.DateFromString
})

/**
 * Like `DbDateTime`, but usable in `Model.Generated(...)` fields.
 *
 * - Decodes from either `Date` (pg drivers) or ISO string (sqlite/pglite).
 * - Encodes as ISO string (for JSON/RPC payloads).
 */
const DbGeneratedDateTime = Schema.transformOrFail(
	Schema.Union(Schema.DateFromSelf, Schema.String),
	Schema.DateFromSelf,
	{
		strict: true,
		decode: (value, _options, ast) => {
			if (value instanceof Date) return ParseResult.succeed(value)
			const date = new Date(value)
			return Number.isNaN(date.getTime())
				? ParseResult.fail(new ParseResult.Type(ast, value, `Invalid datetime string`))
				: ParseResult.succeed(date)
		},
		encode: (value) => ParseResult.succeed(value.toISOString())
	}
)

/**
 * Postgres drivers commonly return BIGINT / INT8 columns as strings.
 *
 * We store these values in the database as integers for indexing / ordering, but decode from either
 * a number (SQLite / PGlite) or a stringified number (Postgres) into a JS number.
 */
const DbInt64AsNumber = Schema.Union(Schema.Number, Schema.NumberFromString)

/**
 * Effect-SQL model for ActionRecord
 */
export class ActionRecord extends Model.Class<ActionRecord>("action_records")({
	id: Model.GeneratedByApp(Schema.UUID),
	server_ingest_id: Model.Generated(Schema.NullOr(DbInt64AsNumber)),
	_tag: Schema.String,
	user_id: Schema.NullOr(Schema.String).pipe(Schema.optionalWith({ default: () => null })),
	client_id: Schema.String,
	transaction_id: Schema.Number,
	clock: JsonColumn(HLC),
	clock_time_ms: Model.Generated(DbInt64AsNumber),
	clock_counter: Model.Generated(DbInt64AsNumber),
	args: JsonColumn(
		Schema.Struct({ timestamp: Schema.Number }, { key: Schema.String, value: Schema.Unknown })
	),
	created_at: DbDateTime,
	// Trusted server-side ingestion timestamp. Used for time-based retention/compaction on the server.
	server_ingested_at: Model.Generated(DbGeneratedDateTime),
	synced: DbBoolean.pipe(Schema.optionalWith({ default: () => false }))
}) {}

export type ActionRecordJson = typeof ActionRecord.json.Type
/**
 * Model for tracking client sync status
 */
export const ClientId = Schema.String.pipe(Schema.brand("sync/clientId"))
export type ClientId = typeof ClientId.Type
export class ClientSyncStatusModel extends Model.Class<ClientSyncStatusModel>("client_sync_status")(
	{
		client_id: ClientId,
		current_clock: JsonColumn(HLC),
		last_synced_clock: JsonColumn(HLC),
		/**
		 * Server sync history generation token (epoch).
		 *
		 * This is provided by the server with sync RPC responses and persisted locally so
		 * clients can detect hard history discontinuities (e.g. DB restore/reset, or a
		 * breaking migration that invalidates replay semantics).
		 *
		 * When it changes, clients must recover by `hardResync()` (no pending local actions)
		 * or `rebase()` (pending local actions), then retry sync.
		 *
		 * Nullable until the client has completed its first successful bootstrap/fetch.
		 */
		server_epoch: Schema.NullOr(Schema.String).pipe(Schema.optionalWith({ default: () => null })),
		last_seen_server_ingest_id: DbInt64AsNumber
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
	audience_key: Schema.String,
	operation: Schema.Literal("INSERT", "UPDATE", "DELETE"),
	forward_patches: JsonColumn(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
	reverse_patches: JsonColumn(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
	sequence: Schema.Number
}) {}

export type ActionModifiedRowJson = typeof ActionModifiedRow.json.Type
