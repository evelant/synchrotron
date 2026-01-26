import { BunRuntime } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { Config, Cause, Duration, Effect, Layer, Schedule } from "effect"
import { setupServerDatabase } from "./setup"

const pgClientConfig: Config.Config.Wrap<PgClient.PgClientConfig> = Config.all({
	url: Config.redacted("ADMIN_DATABASE_URL").pipe(
		Config.orElse(() => Config.redacted("DATABASE_URL"))
	),
	maxConnections: Config.succeed(10),
	idleTimeout: Config.succeed(Duration.seconds(30)),
	onnotice: Config.succeed((notice: any) => console.log(`PgClient notice:`, notice))
})

const PgClientAdminLive = PgClient.layerConfig(pgClientConfig).pipe(
	Layer.tapErrorCause(Effect.logError)
)

const retrySchedule = Schedule.exponential(Duration.millis(100)).pipe(
	Schedule.jittered,
	Schedule.intersect(Schedule.recurs(8))
)

const SetupDb = setupServerDatabase.pipe(
	Effect.tapErrorCause((cause) =>
		Effect.logWarning(`Database setup failed, retrying: ${Cause.pretty(cause)}`)
	),
	Effect.retry(retrySchedule)
)

BunRuntime.runMain(SetupDb.pipe(Effect.provide(PgClientAdminLive), Effect.scoped))
