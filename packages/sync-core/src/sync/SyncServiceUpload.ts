/**
 * SyncService "upload" stage (RPC-only by design).
 *
 * Orchestrates a single upload attempt by:
 * - gating on quarantine state
 * - loading the current batch of unsynced actions (+ AMRs)
 * - logging a structured summary (including CORRECTION preview)
 * - sending via SyncNetworkService and marking actions as synced
 *
 * Larger subroutines are split into small helpers:
 * - `SyncServiceUploadQuarantine` (quarantine gate)
 * - `SyncServiceUploadBatch` (load actions + AMRs)
 * - `SyncServiceUploadDescribe` (pure metadata for logging)
 * - `SyncServiceUploadSend` (span + error logging wrapper)
 */
import type { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { ActionModifiedRowRepo } from "../ActionModifiedRowRepo"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ClientClockState } from "../ClientClockState"
import {
	NetworkRequestError,
	SendLocalActionsBehindHead,
	SendLocalActionsDenied,
	SendLocalActionsInternal,
	SendLocalActionsInvalid,
	type SyncNetworkService
} from "../SyncNetworkService"
import { SyncError } from "../SyncServiceErrors"
import { makeUploadBatchLoader } from "./SyncServiceUploadBatch"
import { describeUploadBatch } from "./SyncServiceUploadDescribe"
import { makeUploadQuarantineGate } from "./SyncServiceUploadQuarantine"
import { sendUploadBatch } from "./SyncServiceUploadSend"

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

	const { getQuarantinedCount } = makeUploadQuarantineGate({ sqlClient })
	const { loadUploadBatch } = makeUploadBatchLoader({ actionRecordRepo, actionModifiedRowRepo })

	/**
	 * Attempt to send all unsynced actions to the server.
	 */
	const sendLocalActions = () =>
		newTraceId.pipe(
			Effect.flatMap((sendBatchId) =>
				Effect.gen(function* () {
					const quarantinedCount = yield* getQuarantinedCount()
					if (quarantinedCount > 0) {
						yield* Effect.logWarning("sendLocalActions.skipped.quarantined", {
							sendBatchId,
							quarantinedCount
						})
						return []
					}

					const { actionsToSend, amrs } = yield* loadUploadBatch()
					if (actionsToSend.length === 0) {
						yield* Effect.logDebug("sendLocalActions.noop", { sendBatchId })
						return []
					}

					const basisServerIngestId = yield* clockState.getLastSeenServerIngestId

					const {
						actionTags,
						amrCountsByActionRecordId,
						correctionActionIds,
						correctionAmrPreview,
						hasCorrectionDelta
					} = describeUploadBatch({ actionsToSend, amrs, valuePreview })

					yield* Effect.logInfo("sendLocalActions.sending", {
						sendBatchId,
						basisServerIngestId,
						actionCount: actionsToSend.length,
						amrCount: amrs.length,
						actionTags,
						hasCorrectionDelta,
						actions: actionsToSend.map((a) => ({
							id: a.id,
							_tag: a._tag,
							client_id: a.client_id,
							clock: a.clock
						})),
						amrCountsByActionRecordId
					})

					if (correctionActionIds.length > 0) {
						yield* Effect.logDebug("sendLocalActions.correctionDelta.preview", {
							sendBatchId,
							correctionActionIds,
							correctionAmrPreview
						})
					}

					yield* sendUploadBatch({
						syncNetworkService,
						clientId,
						sendBatchId,
						basisServerIngestId,
						actionsToSend,
						amrs,
						actionTags
					})

					yield* Effect.gen(function* () {
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
					}).pipe(sqlClient.withTransaction)

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
