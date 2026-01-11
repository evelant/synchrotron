import { Model, SqlClient, SqlSchema, type SqlError } from "@effect/sql"
import { Effect, Schema } from "effect"
import { ActionModifiedRow } from "./models"
import { deepObjectEquals } from "@synchrotron/sync-core/utils"

/**
 * Repository service for ActionModifiedRows with type-safe queries
 */
export class ActionModifiedRowRepo extends Effect.Service<ActionModifiedRowRepo>()(
	"ActionModifiedRowRepo",
	{
		effect: Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient

			const repo = yield* Model.makeRepository(ActionModifiedRow, {
				tableName: "action_modified_rows", 
				idColumn: "id",
				spanPrefix: "ActionModifiedRowRepository" 
			})

			const findByActionRecordIds = SqlSchema.findAll({
				Request: Schema.Array(Schema.String), 
				Result: ActionModifiedRow,
				execute: (ids) => {
					if (ids.length === 0) {
						return sql`SELECT * FROM action_modified_rows WHERE 1 = 0` 
					}
					return sql`
						SELECT amr.* 
						FROM action_modified_rows amr
						JOIN action_records ar ON amr.action_record_id = ar.id
						WHERE amr.action_record_id IN ${sql.in(ids)} 
						ORDER BY ar.clock_time_ms ASC, ar.clock_counter ASC, ar.client_id ASC, ar.id ASC, amr.sequence ASC
					` 
				}
			})

			const findByTransactionId = SqlSchema.findAll({
				Request: Schema.Number,
				Result: ActionModifiedRow,
				execute: (txid) => sql`
                    SELECT amr.* 
                    FROM action_modified_rows amr
                    JOIN action_records ar ON amr.action_record_id = ar.id
                    WHERE ar.transaction_id = ${txid} 
					ORDER BY ar.clock_time_ms ASC, ar.clock_counter ASC, ar.client_id ASC, ar.id ASC, amr.sequence ASC -- Order by HLC first, then sequence
                `
			})

			const allUnsynced = SqlSchema.findAll({
				Request: Schema.Void,
				Result: ActionModifiedRow,
				execute: () =>
					sql`SELECT amr.* FROM action_modified_rows amr join action_records ar on amr.action_record_id = ar.id WHERE ar.synced = 0 ORDER BY amr.sequence ASC`
			})


			const deleteByActionRecordIds = (...actionRecordId: string[]) =>
				Effect.gen(function* () {
					if (actionRecordId.length === 0) return
					yield* sql`DELETE FROM action_modified_rows WHERE action_record_id IN ${sql.in(actionRecordId)}`
				})
			
			const all = SqlSchema.findAll({
				Request: Schema.Void,
				Result: ActionModifiedRow,
				execute: () => sql`SELECT * FROM action_modified_rows`
			})

			return {
				...repo,
				all,
				allUnsynced,
				findByActionRecordIds,
				findByTransactionId,
				deleteByActionRecordIds,
			} as const
		}),
	}
) {}

/**
 * Deep compares two sets of ActionModifiedRow arrays based on the *final* state 
 * implied by the sequence of changes for each modified row.
 */
export const compareActionModifiedRows = (
	rowsA: readonly ActionModifiedRow[],
	rowsB: readonly ActionModifiedRow[]
): boolean => {
	const findLastAmrForKeyAndColumn = (rows: readonly ActionModifiedRow[]) => {
		const lastAmrsByColumn = new Map<string, Record<string, unknown>>()
		const operationsByKey = new Map<string, string>()

		for (const row of rows) {
			const key = `${row.table_name}|${row.row_id}`
			
			// Track the latest operation for each row
			operationsByKey.set(key, row.operation)
			
			// Get or initialize the column map for this row
			if (!lastAmrsByColumn.has(key)) {
				lastAmrsByColumn.set(key, {})
			}
			
			// Update each column with the latest value from the patches
			const columnValues = lastAmrsByColumn.get(key)!
			for (const [columnKey, columnValue] of Object.entries(row.forward_patches)) {
				columnValues[columnKey] = columnValue
			}
		}

		return { lastAmrsByColumn, operationsByKey }
	}

	const { lastAmrsByColumn: lastColumnValuesA, operationsByKey: operationsA } = findLastAmrForKeyAndColumn(rowsA)
	const { lastAmrsByColumn: lastColumnValuesB, operationsByKey: operationsB } = findLastAmrForKeyAndColumn(rowsB)

	// Check if we have the same set of row keys
	if (lastColumnValuesA.size !== lastColumnValuesB.size) {
		console.log(`AMR compare fail: Final state size mismatch ${lastColumnValuesA.size} vs ${lastColumnValuesB.size}`)
		return false
	}

	// Compare each row
	for (const [key, columnsA] of lastColumnValuesA) {
		const columnsB = lastColumnValuesB.get(key)
		if (!columnsB) {
			console.log(`AMR compare fail: Row key ${key} missing in final state B`)
			return false
		}

		// Compare operations
		const operationA = operationsA.get(key)
		const operationB = operationsB.get(key)
		if (operationA !== operationB) {
			console.log(
				`AMR compare fail: Final operation mismatch for key ${key}: ${operationA} vs ${operationB}`
			)
			return false
		}

		// Get all unique column keys from both sets
		const allColumnKeys = new Set([
			...Object.keys(columnsA),
			...Object.keys(columnsB)
		])

		// Compare each column value
		for (const columnKey of allColumnKeys) {
			const valueA = columnsA[columnKey]
			const valueB = columnsB[columnKey]

			if (!deepObjectEquals(valueA, valueB)) {
				console.log(`AMR compare fail: Final value differs for key ${key}, column ${columnKey}`)
				console.log(`Column A value: ${JSON.stringify(valueA)}`)
				console.log(`Column B value: ${JSON.stringify(valueB)}`)
				return false
			}
		}
	}

	return true
}
