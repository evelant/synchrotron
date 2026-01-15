import { PgClient } from "@effect/sql-pg"
import { Config, Duration, Effect, Layer } from "effect"

/**
 * Configuration structure for the PostgreSQL client.
 * Defines the required configuration parameters using Effect's Config module.
 */
const config: Config.Config.Wrap<PgClient.PgClientConfig> = Config.all({
	url: Config.redacted("DATABASE_URL"),
	debug: Config.succeed((a: any, b: any, c: any, d: any) => {
		// console.log(`PgClient debug:`, a, b, c, d)
	}),
	maxConnections: Config.succeed(100),
	idleTimeout: Config.succeed(Duration.seconds(120)),
	onnotice: Config.succeed((notice: any) => console.log(`PgClient notice:`, notice))
})

/**
 * Live Layer providing the Sql.SqlClient service using PostgreSQL.
 * Uses `layerConfig` to create the layer from the defined configuration structure.
 * This layer reads configuration and creates the PgClient.
 */
export const PgClientLive = PgClient.layerConfig(config).pipe(Layer.tapErrorCause(Effect.logError))
