import type { SqlError } from "@effect/sql"
import { Context, Effect } from "effect"

export type ClientDbDialect = "postgres" | "sqlite" | "unknown"

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

	readonly initializeSyncSchema: Effect.Effect<void, SqlError.SqlError | Error>

	readonly installPatchCapture: (
		tableNames: ReadonlyArray<string>
	) => Effect.Effect<void, SqlError.SqlError | Error>

	readonly setCaptureContext: (
		actionRecordId: string | null
	) => Effect.Effect<void, SqlError.SqlError | Error>

	readonly setPatchTrackingEnabled: (
		enabled: boolean
	) => Effect.Effect<void, SqlError.SqlError | Error>

	readonly withPatchTrackingDisabled: <A, E, R>(
		effect: Effect.Effect<A, E, R>
	) => Effect.Effect<A, E | SqlError.SqlError | Error, R>

	readonly withCaptureContext: <A, E, R>(
		actionRecordId: string | null,
		effect: Effect.Effect<A, E, R>
	) => Effect.Effect<A, E | SqlError.SqlError | Error, R>
}

export class ClientDbAdapter extends Context.Tag("ClientDbAdapter")<
	ClientDbAdapter,
	ClientDbAdapterService
>() {}
