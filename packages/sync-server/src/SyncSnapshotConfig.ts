import { Context, Layer } from "effect"

export interface SyncSnapshotConfigData {
	/**
	 * List of base tables to include in bootstrap snapshots.
	 *
	 * These must exist in the DB schema and be visible to the requesting user under RLS.
	 */
	readonly tables: readonly string[]
}

export class SyncSnapshotConfig extends Context.Tag("SyncSnapshotConfig")<
	SyncSnapshotConfig,
	SyncSnapshotConfigData
>() {}

export const createSyncSnapshotConfig = (tables: readonly string[]) =>
	Layer.succeed(SyncSnapshotConfig, { tables })
