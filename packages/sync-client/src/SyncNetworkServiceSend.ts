/**
 * RPC implementation details for `SyncNetworkService.sendLocalActions`.
 *
 * This module is intentionally transport-only: it sends already materialized local actions +
 * their AMRs to the server. It does not attempt to ingest remote state or apply changes locally.
 *
 * Logging is verbose by design to aid debugging sync correctness (especially CORRECTION deltas).
 */
import type { RpcClientError } from "@effect/rpc"
import type { BadArgument } from "@effect/platform/Error"
import { NetworkRequestError } from "@synchrotron/sync-core/SyncNetworkService"
import type { SendLocalActionsFailure } from "@synchrotron/sync-core/SyncNetworkService"
import type { SyncNetworkService } from "@synchrotron/sync-core/SyncNetworkService"
import type { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"
import { CorrectionActionTag } from "@synchrotron/sync-core"
import { Cause, Chunk, Effect } from "effect"

type SyncNetworkRpcClient = Readonly<{
	SendLocalActions: (payload: {
		readonly clientId: string
		readonly basisServerIngestId: number
		readonly actions: ReadonlyArray<ActionRecord>
		readonly amrs: ReadonlyArray<ActionModifiedRow>
	}) => Effect.Effect<
		boolean,
		BadArgument | RpcClientError.RpcClientError | SendLocalActionsFailure,
		never
	>
}>

const valuePreview = (value: unknown, maxLength = 500) => {
	const json = JSON.stringify(value)
	return json.length <= maxLength ? json : `${json.slice(0, maxLength)}…`
}

const summarizeActions = (actions: ReadonlyArray<ActionRecord>) =>
	actions.map((a) => ({
		id: a.id,
		_tag: a._tag,
		client_id: a.client_id,
		server_ingest_id: a.server_ingest_id,
		transaction_id: a.transaction_id,
		clock: a.clock
	}))

const summarizeAmrs = (amrs: ReadonlyArray<ActionModifiedRow>) => {
	const countsByActionRecordId: Record<string, number> = {}
	const countsByTable: Record<string, number> = {}
	for (const amr of amrs) {
		countsByActionRecordId[amr.action_record_id] =
			(countsByActionRecordId[amr.action_record_id] ?? 0) + 1
		countsByTable[amr.table_name] = (countsByTable[amr.table_name] ?? 0) + 1
	}
	return { countsByActionRecordId, countsByTable }
}

export const makeSendLocalActions = (deps: {
	readonly clientId: string
	readonly client: SyncNetworkRpcClient
}): SyncNetworkService["sendLocalActions"] => {
	const { clientId, client } = deps

	return (
		actions: ReadonlyArray<ActionRecord>,
		amrs: ReadonlyArray<ActionModifiedRow>,
		basisServerIngestId
	) =>
		Effect.gen(function* () {
			const amrSummary = summarizeAmrs(amrs)
			yield* Effect.logInfo("sync.network.sendLocalActions.start", {
				clientId,
				basisServerIngestId,
				actionCount: actions.length,
				amrCount: amrs.length,
				actionTags: actions.reduce<Record<string, number>>((acc, a) => {
					acc[a._tag] = (acc[a._tag] ?? 0) + 1
					return acc
				}, {}),
				amrCountsByTable: amrSummary.countsByTable
			})

			const correctionActionIds = new Set(
				actions.filter((a) => a._tag === CorrectionActionTag).map((a) => a.id)
			)
			if (correctionActionIds.size > 0) {
				const correctionAmrs = amrs
					.filter((amr) => correctionActionIds.has(amr.action_record_id))
					.slice(0, 10)
				yield* Effect.logDebug("sync.network.sendLocalActions.correctionDelta.preview", {
					clientId,
					correctionActionIds: Array.from(correctionActionIds),
					correctionAmrPreview: correctionAmrs.map((amr) => ({
						id: amr.id,
						table_name: amr.table_name,
						row_id: amr.row_id,
						operation: amr.operation,
						forward_patches: valuePreview(amr.forward_patches),
						reverse_patches: valuePreview(amr.reverse_patches)
					}))
				})
			}

			yield* Effect.logDebug("sync.network.sendLocalActions.payload", {
				clientId,
				actions: summarizeActions(actions),
				amrs: {
					countsByActionRecordId: amrSummary.countsByActionRecordId,
					countsByTable: amrSummary.countsByTable
				}
			})

			const result = yield* client.SendLocalActions({
				actions,
				amrs,
				clientId,
				basisServerIngestId
			})
			yield* Effect.logInfo("sync.network.sendLocalActions.success", {
				clientId,
				basisServerIngestId,
				actionCount: actions.length,
				amrCount: amrs.length
			})
			return result
		}).pipe(
			Effect.tapErrorCause((c) =>
				Effect.logError("sync.network.sendLocalActions.error", {
					clientId,
					cause: Cause.pretty(c),
					defects: Cause.defects(c).pipe(
						Chunk.map((d) => JSON.stringify(d, undefined, 2)),
						Chunk.toArray
					)
				})
			),
			Effect.catchTag("RpcClientError", (error: RpcClientError.RpcClientError) =>
				Effect.fail(
					new NetworkRequestError({
						message: error.message,
						cause: error.cause ?? error
					})
				)
			)
		)
}
