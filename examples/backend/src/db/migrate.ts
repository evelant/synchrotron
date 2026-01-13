import { BunRuntime } from "@effect/platform-bun"
import { PgClientLive } from "@synchrotron/sync-server/db/connection"
import { Cause, Duration, Effect, Schedule } from "effect"
import { setupServerDatabase } from "./setup"

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

BunRuntime.runMain(SetupDb.pipe(Effect.provide(PgClientLive), Effect.scoped))
