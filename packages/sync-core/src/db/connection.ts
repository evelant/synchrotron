import { PgLiteClient } from "@effect/sql-pglite"
import { electricSync } from "@electric-sql/pglite-sync"
import { live } from "@electric-sql/pglite/live"
import { vector } from "@electric-sql/pglite/vector"
import { Schema } from "effect"

/**
 * Error class for database operations
 */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Unknown)
}) {}

// Create a tag for your client with extensions
export const PgLiteTag = PgLiteClient.tag<{
	vector: typeof vector
	live: typeof live
	electric: ReturnType<typeof electricSync>
}>()

/**
 * Create a PGLite client with support for Electric sync
 * This provides both the PGLite client and SqlClient.SqlClient
 */
export const PgLiteSyncLayer = PgLiteClient.layer({
	// debug: 1,
	// Use memory:// for tests regardless of how NODE_ENV is set
	// This ensures consistent behavior when running from different directories
	dataDir: "memory://",
	relaxedDurability: false,
	extensions: {
		electric: electricSync(),
		live,
		vector
	}
})
