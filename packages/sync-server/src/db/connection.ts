import * as Sql from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { Config, Effect, Layer, Redacted } from "effect" // Import Redacted

/**
 * Configuration structure for the PostgreSQL client.
 * Defines the required configuration parameters using Effect's Config module.
 */
const config = Config.all({
  url: Config.redacted("DATABASE_URL"), // Use Config.redacted for the URL
  // Add other PgClientConfig fields here if needed, e.g.,
  // ssl: Config.boolean("DATABASE_SSL").withDefault(false),
  // connectionTTL: Config.duration("DATABASE_CONNECTION_TTL").withDefault("30 seconds")
})

/**
 * Live Layer providing the Sql.SqlClient service using PostgreSQL.
 * Uses `layerConfig` to create the layer from the defined configuration structure.
 * This layer reads configuration and creates the PgClient.
 */
export const PgClientLive = PgClient.layerConfig(config).pipe(
  // Log any errors during layer creation (including config errors)
  Layer.tapErrorCause(Effect.logError)
)

// Export the SqlClient Tag for convenience
export const SqlClient = Sql.SqlClient