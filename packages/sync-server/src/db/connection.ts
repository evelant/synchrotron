import * as Sql from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { Config, Effect, Layer } from "effect"

/**
 * Configuration structure for the PostgreSQL client.
 * Defines the required configuration parameters using Effect's Config module.
 */
const config = Config.all({
	url: Config.redacted("DATABASE_URL"),
	debug: Config.succeed((a: any, b: any, c: any, d: any) => console.log(a, b, c, d))
})

/**
 * Live Layer providing the Sql.SqlClient service using PostgreSQL.
 * Uses `layerConfig` to create the layer from the defined configuration structure.
 * This layer reads configuration and creates the PgClient.
 */
export const PgClientLive = PgClient.layerConfig(config).pipe(Layer.tapErrorCause(Effect.logError))

export const SqlClient = Sql.SqlClient
