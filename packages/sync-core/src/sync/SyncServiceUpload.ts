import type { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { ActionModifiedRow } from "../models"
import type { ActionRecord } from "../models"
import type { ActionModifiedRowRepo } from "../ActionModifiedRowRepo"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ClientClockState } from "../ClientClockState"
import { CorrectionActionTag } from "../SyncActionTags"
import {
	NetworkRequestError,
	SendLocalActionsBehindHead,
	SendLocalActionsDenied,
	SendLocalActionsInternal,
	SendLocalActionsInvalid,
	type SyncNetworkService
} from "../SyncNetworkService"
import { SyncError } from "../SyncServiceErrors"

export const makeUpload = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly actionRecordRepo: ActionRecordRepo
	readonly actionModifiedRowRepo: ActionModifiedRowRepo
	readonly syncNetworkService: SyncNetworkService
	readonly clockState: ClientClockState
	readonly clientId: string
	readonly newTraceId: Effect.Effect<string>
	readonly valuePreview: (value: unknown, maxLength?: number) => string
}) => {
	const {
		sqlClient,
		actionRecordRepo,
		actionModifiedRowRepo,
		syncNetworkService,
		clockState,
		clientId,
		newTraceId,
		valuePreview
	} = deps

	/**
	 * Attempt to send all unsynced actions to the server.
	 */
	const sendLocalActions = () =>
		newTraceId.pipe(
			Effect.flatMap((sendBatchId) =>
				Effect.gen(function* () {
					const quarantineRows = yield* sqlClient<{ readonly count: number | string }>`
						SELECT count(*) as count FROM local_quarantined_actions
					`
					const quarantinedCountRaw = quarantineRows[0]?.count ?? 0
					const quarantinedCount =
						typeof quarantinedCountRaw === "number"
							? quarantinedCountRaw
							: Number(quarantinedCountRaw ?? 0)
					if (quarantinedCount > 0) {
						yield* Effect.logWarning("sendLocalActions.skipped.quarantined", {
							sendBatchId,
							quarantinedCount
						})
						return []
					}

					const actionsToSendRaw = yield* actionRecordRepo.allUnsyncedActive()
					const actionIdsToSend = actionsToSendRaw.map((a) => a.id)
					const amrs =
						actionIdsToSend.length === 0
							? ([] as const)
							: yield* actionModifiedRowRepo.findByActionRecordIds(actionIdsToSend)
					if (actionsToSendRaw.length === 0) {
						yield* Effect.logDebug("sendLocalActions.noop", { sendBatchId })
						return []
					}

					const actionsToSend = actionsToSendRaw
					const basisServerIngestId = yield* clockState.getLastSeenServerIngestId

					const actionTags = actionsToSend.reduce<Record<string, number>>((acc, action) => {
						acc[action._tag] = (acc[action._tag] ?? 0) + 1
						return acc
					}, {})
					const amrCountsByActionRecordId: Record<string, number> = {}
					for (const amr of amrs) {
						amrCountsByActionRecordId[amr.action_record_id] =
							(amrCountsByActionRecordId[amr.action_record_id] ?? 0) + 1
					}

					yield* Effect.logInfo("sendLocalActions.sending", {
						sendBatchId,
						basisServerIngestId,
						actionCount: actionsToSend.length,
						amrCount: amrs.length,
						actionTags,
						hasCorrectionDelta: actionsToSend.some((a) => a._tag === CorrectionActionTag),
						actions: actionsToSend.map((a) => ({
							id: a.id,
							_tag: a._tag,
							client_id: a.client_id,
							clock: a.clock
						})),
						amrCountsByActionRecordId
					})

					const correctionActionIds = actionsToSend
						.filter((a) => a._tag === CorrectionActionTag)
						.map((a) => a.id)
					if (correctionActionIds.length > 0) {
						const correctionActionIdSet = new Set(correctionActionIds)
						const correctionAmrPreview = amrs
							.filter((amr) => correctionActionIdSet.has(amr.action_record_id))
							.slice(0, 10)
							.map((amr) => ({
								id: amr.id,
								table_name: amr.table_name,
								row_id: amr.row_id,
								operation: amr.operation,
								forward_patches: valuePreview(amr.forward_patches),
								reverse_patches: valuePreview(amr.reverse_patches)
							}))
						yield* Effect.logDebug("sendLocalActions.correctionDelta.preview", {
							sendBatchId,
							correctionActionIds,
							correctionAmrPreview
						})
					}

					yield* syncNetworkService
						.sendLocalActions(
							actionsToSend as ReadonlyArray<ActionRecord>,
							amrs as ReadonlyArray<ActionModifiedRow>,
							basisServerIngestId
						)
						.pipe(
							Effect.withSpan("SyncNetworkService.sendLocalActions", {
								attributes: {
									clientId,
									sendBatchId,
									actionCount: actionsToSend.length,
									amrCount: amrs.length
								}
							}),
							Effect.tapError((error) => {
								const errorTag =
									typeof error === "object" && error !== null
										? ((error as { readonly _tag?: unknown })._tag ?? null)
										: null
								return Effect.logError("sendLocalActions.sendFailed", {
									sendBatchId,
									actionCount: actionsToSend.length,
									amrCount: amrs.length,
									actionTags,
									errorTag: typeof errorTag === "string" ? errorTag : null,
									errorMessage: error instanceof Error ? error.message : String(error)
								})
							})
						)

					for (const action of actionsToSend) {
						yield* actionRecordRepo.markAsSynced(action.id)
						yield* Effect.logDebug("sendLocalActions.markedSynced", {
							sendBatchId,
							actionId: action.id,
							actionTag: action._tag
						})
					}
					yield* clockState.updateLastSyncedClock().pipe(
						Effect.mapError(
							(error) =>
								new SyncError({
									message: "Failed to update last_synced_clock",
									cause: error
								})
						)
					)

					return actionsToSend // Return the actions that were handled
				}).pipe(
					Effect.catchAll((error) => {
						if (
							error instanceof SendLocalActionsBehindHead ||
							error instanceof SendLocalActionsDenied ||
							error instanceof SendLocalActionsInvalid ||
							error instanceof SendLocalActionsInternal ||
							error instanceof NetworkRequestError ||
							error instanceof SyncError
						) {
							return Effect.fail(error)
						}
						const message = error instanceof Error ? error.message : String(error)
						return Effect.fail(
							new SyncError({
								message: `Failed during sendLocalActions: ${message}`,
								cause: error
							})
						)
					}),
					Effect.annotateLogs({ clientId, sendBatchId, operation: "sendLocalActions" }),
					Effect.withSpan("SyncService.sendLocalActions", {
						attributes: { clientId, sendBatchId }
					})
				)
			)
		)

	return { sendLocalActions } as const
}
