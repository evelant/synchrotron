import { SqlClient } from "@effect/sql"
import { Config, Duration, Effect, Option } from "effect"
import { ServerMetaService } from "./ServerMetaService"
import { SyncRetentionConfig } from "./SyncRetentionConfig"
import { makeCompaction } from "./server/SyncServerCompaction"
import { makeFetch } from "./server/SyncServerFetch"
import { makeReceiveActions } from "./server/SyncServerReceiveActions"
import { makeSnapshot } from "./server/SyncServerSnapshot"

export { ServerConflictError, ServerInternalError } from "./SyncServerServiceErrors"
export type { BootstrapSnapshotResult, FetchActionsResult } from "./SyncServerServiceTypes"

export class SyncServerService extends Effect.Service<SyncServerService>()("SyncServerService", {
	effect: Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		const serverMeta = yield* ServerMetaService

		const { compactActionLogOnce, startActionLogCompactor, minRetainedServerIngestId } =
			makeCompaction({ sql })

		const retentionConfigOption = yield* Effect.serviceOption(SyncRetentionConfig)
		if (Option.isSome(retentionConfigOption)) {
			const { actionLogRetention, compactionInterval } = retentionConfigOption.value
			yield* Effect.logInfo("server.compaction.enabled.layer", {
				retentionMs: Duration.toMillis(actionLogRetention),
				intervalMs: Duration.toMillis(compactionInterval)
			})
			yield* startActionLogCompactor({ actionLogRetention, compactionInterval })
		} else {
			const envRetentionOption = yield* Config.duration("SYNC_ACTION_LOG_RETENTION").pipe(
				Config.option
			)
			if (Option.isSome(envRetentionOption)) {
				const compactionInterval = yield* Config.duration(
					"SYNC_ACTION_LOG_COMPACTION_INTERVAL"
				).pipe(Config.withDefault(Duration.hours(1)))
				yield* Effect.logInfo("server.compaction.enabled.env", {
					retentionMs: Duration.toMillis(envRetentionOption.value),
					intervalMs: Duration.toMillis(compactionInterval)
				})
				yield* startActionLogCompactor({
					actionLogRetention: envRetentionOption.value,
					compactionInterval
				})
			} else {
				yield* Effect.logDebug("server.compaction.disabled")
			}
		}

		const { receiveActions } = makeReceiveActions({ sql })

		const { getActionsSince } = makeFetch({
			sql,
			serverMeta,
			minRetainedServerIngestId
		})

		const { getBootstrapSnapshot } = makeSnapshot({
			sql,
			serverMeta,
			minRetainedServerIngestId
		})

		return {
			receiveActions,
			getActionsSince,
			getBootstrapSnapshot,
			compactActionLogOnce
		}
	}),
	dependencies: [ServerMetaService.Default]
}) {}
