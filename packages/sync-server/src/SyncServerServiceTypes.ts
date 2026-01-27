import type { HLC } from "@synchrotron/sync-core/HLC"
import type { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"

export interface FetchActionsResult {
	readonly serverEpoch: string
	readonly minRetainedServerIngestId: number
	readonly actions: readonly ActionRecord[]
	readonly modifiedRows: readonly ActionModifiedRow[]
}

export interface BootstrapSnapshotResult {
	readonly serverEpoch: string
	readonly minRetainedServerIngestId: number
	readonly serverIngestId: number
	readonly serverClock: HLC
	readonly tables: ReadonlyArray<{
		readonly tableName: string
		readonly rows: ReadonlyArray<Record<string, unknown>>
	}>
}
