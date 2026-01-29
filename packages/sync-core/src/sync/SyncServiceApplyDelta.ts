/**
 * Computes divergence and outgoing CORRECTION delta information for a replay.
 *
 * Inputs:
 * - `generatedPatches`: patches captured from replaying actions locally
 * - `originalPatches`: patches originally received for the base remote actions
 * - `knownPatches`: patches already known/received (base + received CORRECTIONs)
 *
 * Output is pure/in-memory and is used by `SyncServiceApply` for logging and deciding whether
 * to keep/delete the placeholder outgoing CORRECTION action.
 */
import type { ActionModifiedRow } from "../models"
import { compareActionModifiedRows } from "../ActionModifiedRowRepo"
import { deepObjectEquals } from "../utils"

type RowKey = { table_name: string; row_id: string }

type FinalRowEffect = {
	operation: ActionModifiedRow["operation"]
	columns: Record<string, unknown>
}

type CorrectionDeltaDetails = {
	table_name: string
	row_id: string
	generatedOperation: string
	knownOperation: string
	missingColumns: string[]
	differingColumns: string[]
	missingColumnDetails: Array<{
		column: string
		generatedKind: string
		generatedPreview: string
	}>
	differingColumnDetails: Array<{
		column: string
		generatedKind: string
		generatedPreview: string
		knownKind: string
		knownPreview: string
	}>
	isOverwrite: boolean
}

/**
 * Reduce a list of ActionModifiedRows into the final row-level effects (last-wins per column).
 * Used so we can compare convergence in terms of materialized end state, not AMR sequence identity.
 */
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

/**
 * Returns true if every column/value produced by the replay is already implied by known patches.
 * DELETE is treated as terminal for a row (only DELETE covers DELETE).
 */
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

/**
 * Compute both:
 * - strict divergence (generated vs original) via `compareActionModifiedRows`
 * - remaining delta after accounting for known patches (generated minus known)
 */
export const computeCorrectionDelta = (args: {
	readonly generatedPatches: readonly ActionModifiedRow[]
	readonly originalPatches: readonly ActionModifiedRow[]
	readonly knownPatches: readonly ActionModifiedRow[]
	readonly valueKind: (value: unknown) => string
	readonly valuePreview: (value: unknown, maxLength?: number) => string
}) => {
	const { generatedPatches, originalPatches, knownPatches, valueKind, valuePreview } = args

	const arePatchesIdentical = compareActionModifiedRows(generatedPatches, originalPatches)

	const generatedFinalEffects = toFinalRowEffects(generatedPatches)
	const knownFinalEffects = toFinalRowEffects(knownPatches)

	const deltaRowKeys: RowKey[] = []
	const coveredRowKeys: RowKey[] = []
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

	if (!hasCorrectionDelta) {
		return {
			arePatchesIdentical,
			hasCorrectionDelta,
			deltaRowKeys,
			coveredRowKeys,
			deltaDetails: [] as CorrectionDeltaDetails[],
			hasOverwrites: false,
			overwriteRowCount: 0,
			missingOnlyRowCount: 0
		} as const
	}

	const deltaDetails: CorrectionDeltaDetails[] = deltaRowKeys.map(({ table_name, row_id }) => {
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

	return {
		arePatchesIdentical,
		hasCorrectionDelta,
		deltaRowKeys,
		coveredRowKeys,
		deltaDetails,
		hasOverwrites,
		overwriteRowCount,
		missingOnlyRowCount
	} as const
}
