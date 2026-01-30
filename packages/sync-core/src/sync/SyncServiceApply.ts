/**
 * SyncService "apply" stage.
 *
 * Applies remote actions (DB-driven) and detects divergence by:
 * 1) creating a placeholder outgoing CORRECTION record to capture replay patches
 * 2) applying incoming remote actions in HLC order (including applying received CORRECTION patches)
 * 3) comparing replay-generated patches vs original remote patches and vs "known" patches (base + received CORRECTIONs)
 * 4) either deleting the placeholder (no delta) or pruning + keeping it (delta remains)
 *
 * This file is intentionally an orchestrator; heavy subroutines live in:
 * - `SyncServiceApplyRemoteAction` (apply-one-remote-action)
 * - `SyncServiceApplyDelta` (pure divergence/delta computation)
 * - `SyncServiceApplyCorrectionPlaceholder` (placeholder lifecycle + pruning/clock update)
 */
import type { SqlClient } from "@effect/sql"
import { Effect, Metric } from "effect"
import type { ActionRecord } from "../models"
import type { ActionModifiedRowRepo } from "../ActionModifiedRowRepo"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ActionRegistry } from "../ActionRegistry"
import type { ClientClockState } from "../ClientClockState"
import type { ClientDbAdapterService } from "../ClientDbAdapter"
import { sortClocks } from "../ClockOrder"
import type { DeterministicId } from "../DeterministicId"
import * as SyncMetrics from "../observability/metrics"
import { CorrectionActionTag, RollbackActionTag } from "../SyncActionTags"
import { SyncError } from "../SyncServiceErrors"
import { makeCorrectionPlaceholderManager } from "./SyncServiceApplyCorrectionPlaceholder"
import { computeCorrectionDelta } from "./SyncServiceApplyDelta"
import { makeRemoteActionApplier } from "./SyncServiceApplyRemoteAction"

export const makeApplyActionRecords = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly clientDbAdapter: ClientDbAdapterService
	readonly clockState: ClientClockState
	readonly actionRecordRepo: ActionRecordRepo
	readonly actionModifiedRowRepo: ActionModifiedRowRepo
	readonly actionRegistry: ActionRegistry
	readonly deterministicId: DeterministicId
	readonly clientId: string
	readonly newTraceId: Effect.Effect<string>
	readonly valueKind: (value: unknown) => string
	readonly valuePreview: (value: unknown, maxLength?: number) => string
}) => {
	const {
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
	} = deps

	const { createCorrectionPlaceholder, finalizeCorrectionPlaceholder } =
		makeCorrectionPlaceholderManager({
			sqlClient,
			clientDbAdapter,
			clockState,
			actionRecordRepo,
			actionModifiedRowRepo,
			clientId
		})

	const { applyOneRemoteAction } = makeRemoteActionApplier({
		sqlClient,
		clientDbAdapter,
		actionRecordRepo,
		actionModifiedRowRepo,
		actionRegistry,
		deterministicId
	})

	/**
	 * Applies incoming remote actions, creating a CORRECTION record to capture the resulting
	 * patches, and compares them against original patches to detect divergence.
	 */
	const applyActionRecords = (remoteActions: readonly ActionRecord[]) =>
		Effect.sync(() => {
			const replayCount = remoteActions.filter((a) => a.synced === false).length
			return {
				remoteCount: remoteActions.length - replayCount,
				replayCount
			} as const
		}).pipe(
			Effect.flatMap(({ remoteCount, replayCount }) =>
		newTraceId.pipe(
			Effect.flatMap((applyBatchId) =>
				Effect.gen(function* () {
					yield* Effect.logInfo(
						`Applying ${remoteActions.length} remote actions and checking for divergence.`
					)
					yield* Effect.logDebug("applyActionRecords.remoteActions", {
						applyBatchId,
						count: remoteActions.length,
						actions: remoteActions.map((a) => ({
							id: a.id,
							_tag: a._tag,
							client_id: a.client_id,
							server_ingest_id: a.server_ingest_id
						}))
					})

					// 1. Create ONE placeholder CORRECTION ActionRecord for the batch
					const correctionRecord = yield* createCorrectionPlaceholder(
						remoteActions.map((a) => a.id)
					)
					yield* Effect.logDebug("applyActionRecords.createdCorrectionPlaceholder", {
						applyBatchId,
						correctionActionRecordId: correctionRecord.id
					})

					// 2. Apply the incoming remote actions' logic (or patches for CORRECTION) in HLC order
					const sortedRemoteActions = sortClocks(
						remoteActions.map((a) => ({ ...a, clientId: a.client_id }))
					)

					for (const actionRecord of sortedRemoteActions) {
						yield* applyOneRemoteAction(actionRecord)
					}
					yield* Effect.logDebug(
						`Finished applying ${remoteActions.length} remote actions logic/patches.`
					)
					// Merge observed remote clocks into the client's current clock so subsequent
					// local actions carry causal context (vector) and don't regress vs. far-future remotes.
					yield* clockState.observeRemoteClocks(sortedRemoteActions.map((a) => a.clock))

					// 3. Fetch *all* generated patches associated with the placeholder CORRECTION ActionRecord
					const generatedPatches = yield* actionModifiedRowRepo.findByActionRecordIds([
						correctionRecord.id
					])

					// 4. Fetch *all* original patches associated with *all* received actions
					const originalRemoteActionIds = sortedRemoteActions
						.filter((a) => a._tag !== CorrectionActionTag && a._tag !== RollbackActionTag)
						.map((a) => a.id)
					const originalPatches =
						yield* actionModifiedRowRepo.findByActionRecordIds(originalRemoteActionIds)
					const knownRemoteActionIds = sortedRemoteActions
						.filter((a) => a._tag !== RollbackActionTag)
						.map((a) => a.id)
					const knownPatches =
						yield* actionModifiedRowRepo.findByActionRecordIds(knownRemoteActionIds)
					yield* Effect.logDebug(`Comparing generated vs original patches for divergence check.`)
					yield* Effect.logDebug(
						`Generated Patches (${generatedPatches.length}): ${JSON.stringify(generatedPatches, null, 2)}`
					)
					yield* Effect.logDebug(
						`Original Patches (${originalPatches.length}): ${JSON.stringify(originalPatches, null, 2)}`
					)
					yield* Effect.logDebug(
						`Known Patches (Base + CORRECTION) (${knownPatches.length}): ${JSON.stringify(knownPatches, null, 2)}`
					)

					// 5. Compare total generated patches vs. total original patches
					const {
						arePatchesIdentical,
						hasCorrectionDelta,
						deltaRowKeys,
						coveredRowKeys,
						deltaDetails,
						hasOverwrites,
						overwriteRowCount,
						missingOnlyRowCount
					} = computeCorrectionDelta({
						generatedPatches,
						originalPatches,
						knownPatches,
						valueKind,
						valuePreview
					})

					yield* Effect.logDebug(
						`Overall Divergence check (strict): Generated ${generatedPatches.length} patches, Original ${originalPatches.length} patches. Identical: ${arePatchesIdentical}`
					)
					yield* Effect.logDebug(
						`CORRECTION delta check (generated - known): delta rows=${deltaRowKeys.length}, covered rows=${coveredRowKeys.length}`
					)

					yield* Effect.annotateCurrentSpan({
						remoteCount,
						replayCount,
						hasCorrectionDelta,
						deltaRowCount: deltaRowKeys.length,
						coveredRowCount: coveredRowKeys.length,
						hasOverwrites,
						overwriteRowCount,
						missingOnlyRowCount
					})

					if (hasCorrectionDelta) {
						yield* Metric.increment(
							SyncMetrics.correctionDeltasTotalFor(hasOverwrites ? "overwrite" : "missing_only")
						)

						// Missing-only deltas are the expected RLS/private-data divergence case.
						// Overwrites are a distinct severity class: they can indicate shared-field divergence or action impurity.
						const logDelta = hasOverwrites ? Effect.logError : Effect.logWarning

						yield* logDelta("applyActionRecords.correctionDeltaDetected", {
							applyBatchId,
							correctionActionRecordId: correctionRecord.id,
							deltaRowCount: deltaRowKeys.length,
							coveredRowCount: coveredRowKeys.length,
							hasOverwrites,
							overwriteRowCount,
							missingOnlyRowCount,
							deltaDetails
						})
					}

					// 6. Delete (no delta) or finalize (delta) the placeholder CORRECTION ActionRecord.
					yield* finalizeCorrectionPlaceholder({
						correctionRecordId: correctionRecord.id,
						hasCorrectionDelta,
						coveredRowKeys
					})

					yield* clockState.updateLastSyncedClock().pipe(
						Effect.mapError(
							(error) =>
								new SyncError({
									message: "Failed to update last_synced_clock",
									cause: error
								})
						)
					)

					return remoteActions // Return original remote actions
				}).pipe(
					sqlClient.withTransaction,
					Effect.ensuring(clientDbAdapter.setCaptureContext(null).pipe(Effect.orDie)),
					Effect.annotateLogs({ clientId, applyBatchId, operation: "applyActionRecords" }),
					Effect.withSpan("SyncService.applyActionRecords", {
						attributes: { clientId, applyBatchId, remoteActionCount: remoteActions.length }
					}),
					Metric.trackDuration(SyncMetrics.applyBatchDurationMs),
					Effect.tap(() => Metric.incrementBy(SyncMetrics.actionsAppliedTotalFor("remote"), remoteCount)),
					Effect.tap(() => Metric.incrementBy(SyncMetrics.actionsAppliedTotalFor("replay"), replayCount))
				)
			)
		)
			)
		)

	return { applyActionRecords } as const
}
