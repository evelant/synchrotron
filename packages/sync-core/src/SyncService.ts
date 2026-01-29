/**
 * SyncService: client-side sync runtime orchestrator.
 *
 * This service is a thin composition layer that wires the core sync stages together:
 * - `executeAction`: record + apply a local action with deterministic IDs and patch capture
 * - `performSync`: fetch/ingest remote rows, apply remote actions, reconcile conflicts, and upload pending
 * - `applyActionRecords`: apply remote actions (DB-driven) and compute outgoing CORRECTION deltas
 * - `sendLocalActions`: upload unsynced local actions (RPC-only by design)
 * - `hardResync` / `rebase`: snapshot-based recovery paths
 *
 * Most logic lives in `src/sync/*`; this file mainly:
 * - pulls required services from the Effect environment
 * - constructs internal helpers with explicit dependencies
 * - exports a cohesive API for apps/tests.
 */
import { SqlClient } from "@effect/sql"
import { ActionRegistry } from "@synchrotron/sync-core/ActionRegistry"
import { Effect } from "effect"
import { ActionModifiedRowRepo } from "./ActionModifiedRowRepo"
import { ActionRecordRepo } from "./ActionRecordRepo"
import { ClientClockState } from "./ClientClockState"
import { ClientDbAdapter } from "./ClientDbAdapter"
import { DeterministicId } from "./DeterministicId"
import { SyncNetworkService } from "./SyncNetworkService"
import { makeApplyActionRecords } from "./sync/SyncServiceApply"
import { makeBootstrapSnapshotApplier } from "./sync/SyncServiceBootstrap"
import { makeExecuteAction } from "./sync/SyncServiceExecuteAction"
import { makePerformSync } from "./sync/SyncServicePerformSync"
import { makeQuarantine } from "./sync/SyncServiceQuarantine"
import { makeRecovery } from "./sync/SyncServiceRecovery"
import { makeRollback } from "./sync/SyncServiceRollback"
import { makeUpload } from "./sync/SyncServiceUpload"

export { ActionExecutionError, SyncError } from "./SyncServiceErrors"

export class SyncService extends Effect.Service<SyncService>()("SyncService", {
	scoped: Effect.gen(function* () {
		const sqlClient = yield* SqlClient.SqlClient
		const clientDbAdapter = yield* ClientDbAdapter
		const clockState = yield* ClientClockState
		const actionRecordRepo = yield* ActionRecordRepo
		const actionModifiedRowRepo = yield* ActionModifiedRowRepo
		const syncNetworkService = yield* SyncNetworkService
		const clientId = yield* clockState.getClientId
		const actionRegistry = yield* ActionRegistry
		const deterministicId = yield* DeterministicId

		yield* Effect.logInfo("syncService.start", {
			clientId,
			dbDialect: clientDbAdapter.dialect
		})

		const newTraceId = Effect.sync(() => crypto.randomUUID())
		const valueKind = (value: unknown) =>
			value === null ? "null" : Array.isArray(value) ? "array" : typeof value
		const valuePreview = (value: unknown, maxLength = 300) => {
			try {
				const json = JSON.stringify(value)
				return json.length <= maxLength ? json : `${json.slice(0, maxLength)}…`
			} catch {
				const str = String(value)
				return str.length <= maxLength ? str : `${str.slice(0, maxLength)}…`
			}
		}

		const { applyBootstrapSnapshot, applyBootstrapSnapshotInTx } = makeBootstrapSnapshotApplier({
			sqlClient,
			clientDbAdapter,
			clientId
		})

		const { executeAction } = makeExecuteAction({
			sqlClient,
			clientDbAdapter,
			clockState,
			actionRecordRepo,
			deterministicId,
			clientId
		})

		const { rollbackToAction, rollbackToCommonAncestor } = makeRollback({
			sqlClient,
			clientDbAdapter,
			actionRecordRepo,
			actionModifiedRowRepo,
			clientId
		})

		const { applyActionRecords } = makeApplyActionRecords({
			sqlClient,
			clientDbAdapter,
			clockState,
			actionRecordRepo,
			actionModifiedRowRepo,
			actionRegistry,
			deterministicId,
			clientId,
			newTraceId,
			valueKind,
			valuePreview
		})

		const { sendLocalActions } = makeUpload({
			sqlClient,
			actionRecordRepo,
			actionModifiedRowRepo,
			syncNetworkService,
			clockState,
			clientId,
			newTraceId,
			valuePreview
		})

		const { quarantineUnsyncedActions, getQuarantinedActions, discardQuarantinedActions } =
			makeQuarantine({
				sqlClient,
				actionRecordRepo,
				clientId,
				newTraceId,
				rollbackToAction
			})

		const { hardResync, rebase } = makeRecovery({
			sqlClient,
			clientDbAdapter,
			clockState,
			actionRecordRepo,
			actionModifiedRowRepo,
			syncNetworkService,
			clientId,
			actionRegistry,
			deterministicId,
			newTraceId,
			applyBootstrapSnapshotInTx
		})

		const { performSync } = makePerformSync({
			sqlClient,
			clockState,
			actionRecordRepo,
			syncNetworkService,
			clientId,
			newTraceId,
			applyBootstrapSnapshot,
			rollbackToAction,
			rollbackToCommonAncestor,
			applyActionRecords,
			sendLocalActions,
			hardResync,
			rebase,
			quarantineUnsyncedActions
		})

		const cleanupOldActionRecords = (retentionDays = 7) =>
			Effect.gen(function* () {
				const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000
				yield* sqlClient`
					DELETE FROM action_records
					WHERE synced = 1
					AND clock_time_ms < ${cutoffMs}
				`
				yield* Effect.logInfo(`Cleaned up action records older than ${retentionDays} days`)
				return true
			}).pipe(Effect.annotateLogs("clientId", clientId))

		return {
			executeAction,
			performSync,
			cleanupOldActionRecords,
			applyActionRecords,
			hardResync,
			rebase,
			getQuarantinedActions,
			discardQuarantinedActions
		}
	}),
	dependencies: [
		ActionRecordRepo.Default,
		ActionModifiedRowRepo.Default,
		ActionRegistry.Default,
		DeterministicId.Default
	]
}) {}
