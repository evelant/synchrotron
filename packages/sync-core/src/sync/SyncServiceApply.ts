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
import { SqlClient } from "@effect/sql"
import { Effect, Metric } from "effect"
import type { ActionModifiedRow, ActionRecord } from "../models"
import type { ActionModifiedRowRepo } from "../ActionModifiedRowRepo"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ActionRegistry } from "../ActionRegistry"
import type { ClientClockState } from "../ClientClockState"
import type { ClientDbAdapterService } from "../ClientDbAdapter"
import { sortClocks } from "../ClockOrder"
import type { DeterministicId } from "../DeterministicId"
import * as SyncMetrics from "../observability/metrics"
import { bindJsonParam } from "../SqlJson"
import { CorrectionActionTag, RollbackActionTag } from "../SyncActionTags"
import { SyncError } from "../SyncServiceErrors"
import { applyForwardAmrs } from "../PatchApplier"
import { makeCorrectionPlaceholderManager } from "./SyncServiceApplyCorrectionPlaceholder"
import { computeCorrectionDelta } from "./SyncServiceApplyDelta"
import { makeRemoteActionApplier } from "./SyncServiceApplyRemoteAction"

type RowKey = { table_name: string; row_id: string }

type FinalRowEffect = {
	operation: ActionModifiedRow["operation"]
	columns: Record<string, unknown>
}

const parsePatchObject = (value: unknown): Record<string, unknown> => {
	if (value === null || value === undefined) return {}
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as unknown
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>
			}
		} catch {
			return {}
		}
		return {}
	}

	if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
	return {}
}

/**
 * Reduce a list of ActionModifiedRows into the final row-level effects (last-wins per column).
 *
 * This matches the semantics used by `computeCorrectionDelta`, but we need access to the known
 * row end-state so outgoing CORRECTION AMRs can be normalized for correct apply/rollback.
 */
const toFinalRowEffects = (rows: readonly ActionModifiedRow[]) => {
	const effectsByKey = new Map<string, FinalRowEffect>()
	for (const row of rows) {
		const key = `${row.table_name}|${row.row_id}`
		const existing = effectsByKey.get(key) ?? { operation: row.operation, columns: {} }
		existing.operation = row.operation

		if (row.operation === "DELETE") {
			existing.columns = {}
			effectsByKey.set(key, existing)
			continue
		}

		for (const [columnKey, columnValue] of Object.entries(parsePatchObject(row.forward_patches))) {
			existing.columns[columnKey] = columnValue
		}
		effectsByKey.set(key, existing)
	}
	return effectsByKey
}

const rowKeyOf = (row: RowKey) => `${row.table_name}|${row.row_id}`

const computeMissingReplayRowKeys = (args: {
	readonly originalPatches: readonly ActionModifiedRow[]
	readonly generatedPatches: readonly ActionModifiedRow[]
}) => {
	const { originalPatches, generatedPatches } = args

	const generatedKeys = new Set<string>()
	for (const row of generatedPatches) {
		generatedKeys.add(rowKeyOf(row))
	}

	const missingKeys = new Set<string>()
	const missingRowKeys: RowKey[] = []
	for (const row of originalPatches) {
		const key = rowKeyOf(row)
		if (generatedKeys.has(key) || missingKeys.has(key)) continue
		missingKeys.add(key)
		missingRowKeys.push({ table_name: row.table_name, row_id: row.row_id })
	}

	return { missingRowKeys, missingKeys } as const
}

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

	const normalizeOutgoingCorrectionAmrs = (args: {
		readonly correctionRecordId: string
		readonly generatedPatches: readonly ActionModifiedRow[]
		readonly knownPatches: readonly ActionModifiedRow[]
		readonly deltaRowKeys: readonly RowKey[]
	}) =>
		Effect.gen(function* () {
			const { correctionRecordId, generatedPatches, knownPatches, deltaRowKeys } = args

			if (deltaRowKeys.length === 0) return

			const knownFinalEffects = toFinalRowEffects(knownPatches)

			for (const { table_name, row_id } of deltaRowKeys) {
				const key = `${table_name}|${row_id}`
				const known = knownFinalEffects.get(key)
				if (!known || known.operation === "DELETE") continue

				const generatedForRow = generatedPatches.filter(
					(amr) => amr.table_name === table_name && amr.row_id === row_id
				)

				for (const generated of generatedForRow) {
					if (generated.operation !== "INSERT" && generated.operation !== "UPDATE") continue

					const forward = parsePatchObject(generated.forward_patches)
					const reverse = parsePatchObject(generated.reverse_patches)
					const nextReverse: Record<string, unknown> = { ...reverse }

					if (generated.operation === "INSERT") {
						// Outgoing CORRECTION should represent a delta relative to already-known effects.
						// If the row already exists in known patches, treat a replay INSERT as an UPDATE so:
						// - apply is effective (INSERT-on-conflict would no-op),
						// - rollback only undoes the overwrite (not the existence of the row).
						for (const columnKey of Object.keys(forward)) {
							nextReverse[columnKey] = Object.prototype.hasOwnProperty.call(
								known.columns,
								columnKey
							)
								? known.columns[columnKey]
								: null
						}

						const reverseParam = bindJsonParam(sqlClient, nextReverse)
						yield* sqlClient`
							UPDATE action_modified_rows
							SET operation = 'UPDATE', reverse_patches = ${reverseParam}
							WHERE id = ${generated.id}
							AND action_record_id = ${correctionRecordId}
						`.pipe(Effect.asVoid)
						continue
					}

					// UPDATE: align reverse patches with the known end-state for any columns that are already known.
					for (const columnKey of Object.keys(forward)) {
						if (Object.prototype.hasOwnProperty.call(known.columns, columnKey)) {
							nextReverse[columnKey] = known.columns[columnKey]
						}
					}

					const reverseParam = bindJsonParam(sqlClient, nextReverse)
					yield* sqlClient`
						UPDATE action_modified_rows
						SET reverse_patches = ${reverseParam}
						WHERE id = ${generated.id}
						AND action_record_id = ${correctionRecordId}
					`.pipe(Effect.asVoid)
				}
			}
		}).pipe(Effect.withSpan("SyncService.applyActionRecords.normalizeOutgoingCorrectionAmrs"))

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
							yield* Effect.logDebug(
								`Comparing generated vs original patches for divergence check.`,
								{
									applyBatchId,
									generatedPatchCount: generatedPatches.length,
									originalPatchCount: originalPatches.length,
									knownPatchCount: knownPatches.length
								}
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

							// Subtractive divergence: the remote base patch set contains a row effect that replay did not produce.
							// This can happen when action logic is conditional on private/hidden state. If we do nothing, the base
							// tables diverge permanently because our outgoing delta is only (generated - known).
							//
							// Guardrail: treat `knownPatches` as authoritative for any *base* row keys that are missing from replay,
							// by patch-applying the known patch sequence for those row keys (including any received CORRECTIONs).
							const { missingRowKeys, missingKeys } = computeMissingReplayRowKeys({
								originalPatches,
								generatedPatches
							})
							if (missingRowKeys.length > 0) {
								yield* Effect.logWarning("applyActionRecords.subtractiveDivergencePatched", {
									applyBatchId,
									correctionActionRecordId: correctionRecord.id,
									missingRowCount: missingRowKeys.length,
									// Keep logs bounded.
									missingRowKeys: missingRowKeys.slice(0, 10)
								})

								const patchesToApply = knownPatches.filter((row) => missingKeys.has(rowKeyOf(row)))
								yield* clientDbAdapter.withPatchTrackingDisabled(
									applyForwardAmrs(patchesToApply).pipe(
										Effect.provideService(SqlClient.SqlClient, sqlClient)
									)
								)
							}

							yield* Effect.annotateCurrentSpan({
								remoteCount,
								replayCount,
								hasCorrectionDelta,
								missingKnownRowCount: missingRowKeys.length,
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

							// Normalize outgoing CORRECTION AMRs so they are well-defined deltas relative to known patches.
							// In particular: replay INSERTs for rows that already exist in known patches must be treated
							// as UPDATEs, otherwise apply/rollback semantics are incorrect.
							if (hasCorrectionDelta) {
								yield* normalizeOutgoingCorrectionAmrs({
									correctionRecordId: correctionRecord.id,
									generatedPatches,
									knownPatches,
									deltaRowKeys
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
							Effect.tap(() =>
								Metric.incrementBy(SyncMetrics.actionsAppliedTotalFor("remote"), remoteCount)
							),
							Effect.tap(() =>
								Metric.incrementBy(SyncMetrics.actionsAppliedTotalFor("replay"), replayCount)
							)
						)
					)
				)
			)
		)

	return { applyActionRecords } as const
}
