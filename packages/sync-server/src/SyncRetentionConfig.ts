import { Config, Context, Duration, Effect, Layer, Option } from "effect"

export interface SyncRetentionConfigData {
	/**
	 * How long the server retains `action_records` / `action_modified_rows` history.
	 *
	 * Rows older than this (by `action_records.server_ingested_at`) may be deleted by the compactor.
	 */
	readonly actionLogRetention: Duration.Duration

	/**
	 * How often the server runs the compaction job.
	 */
	readonly compactionInterval: Duration.Duration
}

export class SyncRetentionConfig extends Context.Tag("SyncRetentionConfig")<
	SyncRetentionConfig,
	SyncRetentionConfigData
>() {}

export const createSyncRetentionConfig = (data: SyncRetentionConfigData) =>
	Layer.succeed(SyncRetentionConfig, data)

/**
 * Optional env-based retention config.
 *
 * Enable by setting:
 * - `SYNC_ACTION_LOG_RETENTION` (e.g. `"14 days"`, `"2 weeks"`)
 *
 * Optional:
 * - `SYNC_ACTION_LOG_COMPACTION_INTERVAL` (e.g. `"1 hour"`, default: `"1 hour"`)
 */
export const SyncRetentionConfigFromEnv = Layer.unwrapEffect(
	Effect.gen(function* () {
		const retentionOption = yield* Config.duration("SYNC_ACTION_LOG_RETENTION").pipe(Config.option)
		if (Option.isNone(retentionOption)) {
			return Layer.empty
		}

		const compactionInterval = yield* Config.duration("SYNC_ACTION_LOG_COMPACTION_INTERVAL").pipe(
			Config.withDefault(Duration.hours(1))
		)

		return createSyncRetentionConfig({
			actionLogRetention: retentionOption.value,
			compactionInterval
		})
	})
)

