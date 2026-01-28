import type { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ClientClockState } from "../ClientClockState"
import type { ActionRecord } from "../models"
import { ingestRemoteSyncLogBatch } from "../SyncLogIngest"
import {
	FetchRemoteActionsCompacted,
	SyncHistoryEpochMismatch,
	type SyncNetworkService
} from "../SyncNetworkService"

export type RemoteApplyReadiness =
	| { readonly _tag: "RemoteReady"; readonly remoteActions: readonly ActionRecord[] }
	| { readonly _tag: "RemoteNotReady" }

export const fetchIngestAndListRemoteActions = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly clockState: ClientClockState
	readonly actionRecordRepo: ActionRecordRepo
	readonly syncNetworkService: SyncNetworkService
	readonly clientId: string
	readonly syncSessionId: string
	readonly lastSeenServerIngestId: number
}): Effect.Effect<RemoteApplyReadiness, unknown, never> =>
	Effect.gen(function* () {
		const {
			sqlClient,
			clockState,
			actionRecordRepo,
			syncNetworkService,
			clientId,
			syncSessionId,
			lastSeenServerIngestId
		} = deps

		// 1) Remote ingress (transport-specific).
		//
		// Transports deliver remote sync-log rows; `sync-core` owns the ingestion step
		// (idempotent persistence into `action_records` / `action_modified_rows`).
		//
		// Electric-enabled clients typically return no action rows here (metadata-only) because
		// their authoritative ingress is the Electric stream.
		const fetched = yield* syncNetworkService.fetchRemoteActions().pipe(
			Effect.withSpan("SyncNetworkService.fetchRemoteActions", {
				attributes: { clientId, syncSessionId }
			})
		)

		// 2) Validate epoch + retained history window before ingesting.
		const localEpoch = yield* clockState.getServerEpoch
		if (localEpoch === null) {
			yield* clockState.setServerEpoch(fetched.serverEpoch)
		} else if (localEpoch !== fetched.serverEpoch) {
			return yield* Effect.fail(
				new SyncHistoryEpochMismatch({
					message:
						"Server sync history epoch mismatch (server reset/restore or breaking migration)",
					localEpoch,
					serverEpoch: fetched.serverEpoch
				})
			)
		}
		if (lastSeenServerIngestId + 1 < fetched.minRetainedServerIngestId) {
			return yield* Effect.fail(
				new FetchRemoteActionsCompacted({
					message:
						"Client cursor is older than the server's retained action log history (compacted)",
					sinceServerIngestId: lastSeenServerIngestId,
					minRetainedServerIngestId: fetched.minRetainedServerIngestId,
					serverEpoch: fetched.serverEpoch
				})
			)
		}

		// 3) Idempotently ingest fetched action log rows into local sync tables.
		yield* ingestRemoteSyncLogBatch(sqlClient, {
			actions: fetched.actions,
			modifiedRows: fetched.modifiedRows
		})
		yield* Effect.logInfo("performSync.remoteIngress", {
			fetchedActionCount: fetched.actions.length,
			fetchedAmrCount: fetched.modifiedRows.length
		})

		// 4) Apply is DB-driven: treat `action_records` as the authoritative ingress queue.
		const remoteActions = yield* actionRecordRepo.findSyncedButUnapplied()
		yield* Effect.logInfo("performSync.remoteUnapplied", {
			count: remoteActions.length,
			actions: remoteActions.map((a) => ({
				id: a.id,
				_tag: a._tag,
				client_id: a.client_id,
				server_ingest_id: a.server_ingest_id
			}))
		})

		// 5) Remote actions must have patches ingested before we can safely apply:
		// - rollback correctness requires reverse patches for applied actions
		// - divergence detection requires comparing replay patches vs. original patches
		// If ingress is mid-flight (e.g. action_records arrived before action_modified_rows),
		// bail out and retry later rather than creating spurious outgoing CORRECTION deltas.
		const remoteIdsNeedingPatches = remoteActions
			.filter((a) => a._tag !== "RollbackAction")
			.map((a) => a.id)
		if (remoteIdsNeedingPatches.length > 0) {
			const idsWithPatches = yield* sqlClient<{ readonly action_record_id: string }>`
				SELECT DISTINCT action_record_id
				FROM action_modified_rows
				WHERE action_record_id IN ${sqlClient.in(remoteIdsNeedingPatches)}
			`
			const havePatches = new Set(idsWithPatches.map((r) => r.action_record_id))
			const missingPatchActionIds = remoteIdsNeedingPatches.filter(
				(id) => havePatches.has(id) === false
			)
			if (missingPatchActionIds.length > 0) {
				yield* Effect.logInfo("performSync.remoteNotReady.missingPatches", {
					missingPatchActionCount: missingPatchActionIds.length,
					missingPatchActionIds: missingPatchActionIds.slice(0, 20)
				})
				return { _tag: "RemoteNotReady" } as const
			}
		}

		return { _tag: "RemoteReady", remoteActions } as const
	})
