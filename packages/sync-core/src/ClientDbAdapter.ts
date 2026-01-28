import type { SqlError } from "@effect/sql"
import type { Effect } from "effect"
import { Context, Schema } from "effect"

export type ClientDbDialect = "postgres" | "sqlite" | "unknown"

/**
 * Tagged error for client DB adapter failures.
 *
 * Avoid failing Effects with the global `Error` type so different adapter failures remain
 * distinguishable and type-checkable (and don't collapse into an undifferentiated `Error` union).
 */
export class ClientDbAdapterError extends Schema.TaggedError<ClientDbAdapterError>()(
	"ClientDbAdapterError",
	{
		message: Schema.String,
		expectedDialect: Schema.optional(Schema.String),
		tableName: Schema.optional(Schema.String),
		columnName: Schema.optional(Schema.String),
		cause: Schema.optional(Schema.Unknown)
	}
) {}

/**
 * ClientDbAdapter is the client-side database "dialect adapter".
 *
 * It encapsulates the DB-specific pieces the sync runtime needs (e.g. trigger context,
 * patch tracking toggles, and trigger installation), so we can swap PGlite/Postgres
 * for SQLite (or others) without changing core sync logic.
 *
 * This is intentionally NOT the general query interface - use `SqlClient.SqlClient` for that.
 */
export interface ClientDbAdapterService {
	readonly dialect: ClientDbDialect

	readonly initializeSyncSchema: Effect.Effect<void, SqlError.SqlError | ClientDbAdapterError>

	readonly installPatchCapture: (
		tableNames: ReadonlyArray<string>
	) => Effect.Effect<void, SqlError.SqlError | ClientDbAdapterError>

	readonly setCaptureContext: (
		actionRecordId: string | null
	) => Effect.Effect<void, SqlError.SqlError | ClientDbAdapterError>

	readonly setPatchTrackingEnabled: (
		enabled: boolean
	) => Effect.Effect<void, SqlError.SqlError | ClientDbAdapterError>

	readonly withPatchTrackingDisabled: <A, E, R>(
		effect: Effect.Effect<A, E, R>
	) => Effect.Effect<A, E | SqlError.SqlError | ClientDbAdapterError, R>

	readonly withCaptureContext: <A, E, R>(
		actionRecordId: string | null,
		effect: Effect.Effect<A, E, R>
	) => Effect.Effect<A, E | SqlError.SqlError | ClientDbAdapterError, R>
}

export class ClientDbAdapter extends Context.Tag("ClientDbAdapter")<
	ClientDbAdapter,
	ClientDbAdapterService
>() {}
