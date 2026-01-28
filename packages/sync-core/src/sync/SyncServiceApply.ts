import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { ActionModifiedRow } from "../models"
import { ActionRecord } from "../models"
import type { ActionModifiedRowRepo } from "../ActionModifiedRowRepo"
import { compareActionModifiedRows } from "../ActionModifiedRowRepo"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ActionRegistry } from "../ActionRegistry"
import type { ClientClockState } from "../ClientClockState"
import type { ClientDbAdapterService } from "../ClientDbAdapter"
import { sortClocks } from "../ClockOrder"
import type { DeterministicId } from "../DeterministicId"
import { applyForwardAmrs } from "../PatchApplier"
import { CorrectionActionTag, RollbackActionTag } from "../SyncActionTags"
import { bindJsonParam } from "../SqlJson"
import { SyncError } from "../SyncServiceErrors"
import { deepObjectEquals } from "../utils"

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

	/**
	 * Applies incoming remote actions, creating a CORRECTION record to capture the resulting
	 * patches, and compares them against original patches to detect divergence.
	 */
	const applyActionRecords = (remoteActions: readonly ActionRecord[]) =>
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

					// 1. Use an application-level transaction identifier for the batch.
					const transactionId = Date.now()

					// 2. Create ONE placeholder CORRECTION ActionRecord for the batch
					const correctionActionArgs = {
						appliedActionIds: remoteActions.map((a) => a.id),
						timestamp: 0 // Add placeholder timestamp for internal action
					}
					const currentClock = yield* clockState.getCurrentClock // Use clock before potential increments
					const correctionRecord = yield* actionRecordRepo.insert(
						ActionRecord.insert.make({
							id: crypto.randomUUID(),
							client_id: clientId,
							clock: currentClock, // Use current clock initially
							_tag: CorrectionActionTag,
							args: correctionActionArgs,
							created_at: new Date(),
							synced: false, // Placeholder is initially local
							transaction_id: transactionId
						})
					)
					yield* Effect.logDebug("applyActionRecords.createdCorrectionPlaceholder", {
						applyBatchId,
						correctionActionRecordId: correctionRecord.id
					})
					yield* clientDbAdapter.setCaptureContext(correctionRecord.id)

					// 3. Apply the incoming remote actions' logic (or patches for CORRECTION) in HLC order
					const sortedRemoteActions = sortClocks(
						remoteActions.map((a) => ({ ...a, clientId: a.client_id }))
					)

					const applyOneRemoteAction = (actionRecord: ActionRecord) =>
						Effect.gen(function* () {
							if (actionRecord._tag === RollbackActionTag) {
								yield* Effect.logTrace(
									`Skipping RollbackAction during applyActionRecords (re-materialization is handled at the sync strategy level): ${actionRecord.id}`
								)
								yield* actionRecordRepo.markLocallyApplied(actionRecord.id)
								return // Move to the next action
							}

							const actionCreator = actionRegistry.getActionCreator(actionRecord._tag)

							if (actionRecord._tag === CorrectionActionTag) {
								yield* Effect.logDebug("applyActionRecords.applyReceivedCorrectionPatches", {
									receivedCorrectionActionId: actionRecord.id
								})
								const correctionAmrs = yield* actionModifiedRowRepo.findByActionRecordIds([
									actionRecord.id
								])
								if (correctionAmrs.length > 0) {
									yield* clientDbAdapter.withPatchTrackingDisabled(
										applyForwardAmrs(correctionAmrs).pipe(
											Effect.provideService(SqlClient.SqlClient, sqlClient)
										)
									)
									yield* Effect.logDebug(
										`Applied forward patches for ${correctionAmrs.length} AMRs associated with received CORRECTION action ${actionRecord.id}`
									)
								} else {
									yield* Effect.logWarning(
										`Received CORRECTION action ${actionRecord.id} had no associated ActionModifiedRows.`
									)
								}
							} else if (!actionCreator) {
								return yield* Effect.fail(
									new SyncError({ message: `Missing action creator: ${actionRecord._tag}` })
								)
							} else {
								yield* Effect.logDebug("applyActionRecords.applyRemoteAction", {
									remoteActionId: actionRecord.id,
									remoteActionTag: actionRecord._tag,
									args: actionRecord.args
								})

								yield* deterministicId.withActionContext(
									actionRecord.id,
									actionCreator(actionRecord.args).execute()
								)
							}
							yield* actionRecordRepo.markLocallyApplied(actionRecord.id) // Use new method
							yield* Effect.logDebug(`Marked remote action ${actionRecord.id} as applied locally.`)
						}).pipe(
							Effect.annotateLogs({
								remoteActionId: actionRecord.id,
								remoteActionTag: actionRecord._tag
							}),
							Effect.withSpan("SyncService.applyActionRecords.applyOneRemoteAction", {
								attributes: {
									remoteActionId: actionRecord.id,
									remoteActionTag: actionRecord._tag
								}
							})
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

					// 4. Fetch *all* generated patches associated with the placeholder CORRECTION ActionRecord
					const generatedPatches = yield* actionModifiedRowRepo.findByActionRecordIds([
						correctionRecord.id
					])

					// 5. Fetch *all* original patches associated with *all* received actions
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

					// 6. Compare total generated patches vs. total original patches
					const arePatchesIdentical = compareActionModifiedRows(generatedPatches, originalPatches) // Use strict comparison

					type FinalRowEffect = {
						operation: ActionModifiedRow["operation"]
						columns: Record<string, unknown>
					}

					const toFinalRowEffects = (rows: readonly ActionModifiedRow[]) => {
						const effectsByKey = new Map<string, FinalRowEffect>()
						for (const row of rows) {
							const key = `${row.table_name}|${row.row_id}`
							const existing = effectsByKey.get(key) ?? { operation: row.operation, columns: {} }
							existing.operation = row.operation

							// If the row is deleted, only the delete matters for forward convergence.
							if (row.operation === "DELETE") {
								existing.columns = {}
								effectsByKey.set(key, existing)
								continue
							}

							for (const [columnKey, columnValue] of Object.entries(row.forward_patches)) {
								existing.columns[columnKey] = columnValue
							}
							effectsByKey.set(key, existing)
						}
						return effectsByKey
					}

					const isRowEffectCoveredByKnown = (
						replay: FinalRowEffect,
						known: FinalRowEffect | undefined
					): boolean => {
						if (replay.operation === "DELETE") {
							return known?.operation === "DELETE"
						}
						if (!known) return false
						if (known.operation === "DELETE") return false

						for (const [columnKey, replayValue] of Object.entries(replay.columns)) {
							if (!Object.prototype.hasOwnProperty.call(known.columns, columnKey)) return false
							if (!deepObjectEquals(replayValue, known.columns[columnKey])) return false
						}

						return true
					}

					const generatedFinalEffects = toFinalRowEffects(generatedPatches)
					const knownFinalEffects = toFinalRowEffects(knownPatches)

					const deltaRowKeys: Array<{ table_name: string; row_id: string }> = []
					const coveredRowKeys: Array<{ table_name: string; row_id: string }> = []
					for (const [key, generatedEffect] of generatedFinalEffects) {
						const [table_name, row_id] = key.split("|")
						if (!table_name || !row_id) continue

						if (isRowEffectCoveredByKnown(generatedEffect, knownFinalEffects.get(key))) {
							coveredRowKeys.push({ table_name, row_id })
						} else {
							deltaRowKeys.push({ table_name, row_id })
						}
					}

					const hasCorrectionDelta = deltaRowKeys.length > 0

					yield* Effect.logDebug(
						`Overall Divergence check (strict): Generated ${generatedPatches.length} patches, Original ${originalPatches.length} patches. Identical: ${arePatchesIdentical}`
					)
					yield* Effect.logDebug(
						`CORRECTION delta check (generated - known): delta rows=${deltaRowKeys.length}, covered rows=${coveredRowKeys.length}`
					)

					if (hasCorrectionDelta) {
						const deltaDetails = deltaRowKeys.map(({ table_name, row_id }) => {
							const key = `${table_name}|${row_id}`
							const generated = generatedFinalEffects.get(key)
							const known = knownFinalEffects.get(key)

							const missingColumns: string[] = []
							const differingColumns: string[] = []
							const missingColumnDetails: Array<{
								column: string
								generatedKind: string
								generatedPreview: string
							}> = []
							const differingColumnDetails: Array<{
								column: string
								generatedKind: string
								generatedPreview: string
								knownKind: string
								knownPreview: string
							}> = []

							if (generated?.operation === "DELETE") {
								if (known?.operation !== "DELETE") {
									differingColumns.push("_operation")
									differingColumnDetails.push({
										column: "_operation",
										generatedKind: "string",
										generatedPreview: valuePreview(generated.operation),
										knownKind: "string",
										knownPreview: valuePreview(known?.operation ?? "UNKNOWN")
									})
								}
							} else {
								for (const [columnKey, replayValue] of Object.entries(generated?.columns ?? {})) {
									if (!known || !Object.prototype.hasOwnProperty.call(known.columns, columnKey)) {
										missingColumns.push(columnKey)
										missingColumnDetails.push({
											column: columnKey,
											generatedKind: valueKind(replayValue),
											generatedPreview: valuePreview(replayValue)
										})
										continue
									}
									if (!deepObjectEquals(replayValue, known.columns[columnKey])) {
										differingColumns.push(columnKey)
										differingColumnDetails.push({
											column: columnKey,
											generatedKind: valueKind(replayValue),
											generatedPreview: valuePreview(replayValue),
											knownKind: valueKind(known.columns[columnKey]),
											knownPreview: valuePreview(known.columns[columnKey])
										})
									}
								}
							}

							// "Overwrite" means we are changing a value that was already known for this row.
							// Missing columns / missing rows are the common "private divergence" case and are expected under RLS.
							const hasKnownRow = Boolean(known)
							const operationMismatch = hasKnownRow && generated?.operation !== known?.operation
							const isOverwrite = operationMismatch || (hasKnownRow && differingColumns.length > 0)

							return {
								table_name,
								row_id,
								generatedOperation: generated?.operation ?? "UNKNOWN",
								knownOperation: known?.operation ?? "UNKNOWN",
								missingColumns,
								differingColumns,
								missingColumnDetails,
								differingColumnDetails,
								isOverwrite
							}
						})

						const overwriteRowCount = deltaDetails.filter((d) => d.isOverwrite).length
						const missingOnlyRowCount = deltaDetails.length - overwriteRowCount
						const hasOverwrites = overwriteRowCount > 0

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

					if (!hasCorrectionDelta) {
						yield* Effect.logInfo(
							"No outgoing CORRECTION delta remains after accounting for received patches (base + CORRECTION). Deleting placeholder CORRECTION action."
						)
						yield* actionModifiedRowRepo.deleteByActionRecordIds(correctionRecord.id)
						yield* actionRecordRepo.deleteById(correctionRecord.id)
					} else {
						// 7b. Divergence detected and there is remaining delta to sync:
						yield* Effect.logWarning(
							"Overall divergence detected. Keeping placeholder CORRECTION action."
						)
						// Prune any generated patches that are already covered by received patches (base + CORRECTION).
						for (const { table_name, row_id } of coveredRowKeys) {
							yield* sqlClient`
								DELETE FROM action_modified_rows
								WHERE action_record_id = ${correctionRecord.id}
								AND table_name = ${table_name}
								AND row_id = ${row_id}
							`
						}
						const newCorrectionClock = yield* clockState.incrementClock
						yield* Effect.logDebug(
							`Updating placeholder CORRECTION action ${correctionRecord.id} clock due to divergence: ${JSON.stringify(newCorrectionClock)}`
						)
						const clockValue = bindJsonParam(sqlClient, newCorrectionClock)
						yield* sqlClient`UPDATE action_records SET clock = ${clockValue} WHERE id = ${correctionRecord.id}`
						// The delta patches are already applied locally (they came from replay). Track this so rollbacks are correct.
						yield* actionRecordRepo.markLocallyApplied(correctionRecord.id)
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

					return remoteActions // Return original remote actions
				}).pipe(
					sqlClient.withTransaction,
					Effect.ensuring(clientDbAdapter.setCaptureContext(null).pipe(Effect.orDie)),
					Effect.annotateLogs({ clientId, applyBatchId, operation: "applyActionRecords" }),
					Effect.withSpan("SyncService.applyActionRecords", {
						attributes: { clientId, applyBatchId, remoteActionCount: remoteActions.length }
					})
				)
			)
		)

	return { applyActionRecords } as const
}
