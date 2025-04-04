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

			// Create the base repository
			const repo = yield* Model.makeRepository(ActionModifiedRow, {
				tableName: "action_modified_rows", 
				idColumn: "id",
				spanPrefix: "ActionModifiedRowRepository" 
			})

			// Define type-safe queries
			const findByActionRecordIds = SqlSchema.findAll({
				Request: Schema.Array(Schema.String), 
				Result: ActionModifiedRow,
				execute: (ids) => {
					if (ids.length === 0) {
						return sql`SELECT * FROM action_modified_rows WHERE 1 = 0` 
					}
					// Join action_records to order by HLC (sortable_clock) first, then sequence
					return sql`
						SELECT amr.* 
						FROM action_modified_rows amr
						JOIN action_records ar ON amr.action_record_id = ar.id
						WHERE amr.action_record_id IN ${sql.in(ids)} 
						ORDER BY ar.sortable_clock ASC, amr.sequence ASC
					` 
				}
			})

			const findByTransactionId = SqlSchema.findAll({
				Request: Schema.Number,
				Result: ActionModifiedRow,
				// Join with action_records to filter by transaction_id and order by sequence
				execute: (txid) => sql`
                    SELECT amr.* 
                    FROM action_modified_rows amr
                    JOIN action_records ar ON amr.action_record_id = ar.id
                    WHERE ar.transaction_id = ${txid} 
					ORDER BY ar.sortable_clock ASC, amr.sequence ASC -- Order by HLC first, then sequence
                `
			})

			const allUnsynced = SqlSchema.findAll({
				Request: Schema.Void,
				Result: ActionModifiedRow,
				execute: () =>
					// Order by sequence
					sql`SELECT amr.* FROM action_modified_rows amr join action_records ar on amr.action_record_id = ar.id WHERE ar.synced = false ORDER BY amr.sequence ASC`
			})


			const deleteByActionRecordIds = (...actionRecordId: string[]) =>
				Effect.gen(function* () {
					if (actionRecordId.length === 0) return
					yield* sql`DELETE FROM action_modified_rows WHERE action_record_id IN ${sql.in(actionRecordId)}`
				})
			
			// Removed deleteByTransactionId and associateAmrsToActionRecord

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
				// Removed exports for deleted functions
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
	// Helper to group AMRs and find the one with the highest sequence for each key
	const findLastAmrForKey = (rows: readonly ActionModifiedRow[]) => {
		const lastAmrs = new Map<string, ActionModifiedRow>()
		// Since the input `rows` array is assumed to be pre-sorted correctly
		// (by HLC ASC, then sequence ASC), the last row encountered for a given key
		// represents the final state for that key.
		for (const row of rows) {
			const key = `${row.table_name}|${row.row_id}`
			// Simply overwrite the map entry. The last one wins.
			lastAmrs.set(key, row)
		}
		return lastAmrs
	}

	const lastAmrsA = findLastAmrForKey(rowsA)
	const lastAmrsB = findLastAmrForKey(rowsB)

	// Check if the number of unique modified rows (keys) is the same
	if (lastAmrsA.size !== lastAmrsB.size) {
		console.log(`AMR compare fail: Final state size mismatch ${lastAmrsA.size} vs ${lastAmrsB.size}`)
		return false
	}

	// Compare the final operation and forward patches for each unique row
	for (const [key, lastAmrA] of lastAmrsA) {
		const lastAmrB = lastAmrsB.get(key)
		if (!lastAmrB) {
			console.log(`AMR compare fail: Row key ${key} missing in final state B`)
			return false
		}

		// Compare the operation of the *last* change
		if (lastAmrA.operation !== lastAmrB.operation) {
			console.log(
				`AMR compare fail: Final operation mismatch for key ${key}: ${lastAmrA.operation} vs ${lastAmrB.operation}`
			)
			return false
		}

		// Deep compare forward_patches of the *last* change (representing the final state change)
		if (!deepObjectEquals(lastAmrA.forward_patches, lastAmrB.forward_patches)) {
			console.log(`AMR compare fail: Final forward patches differ for key ${key}`)
			console.log(`Row A Final Patches: ${JSON.stringify(lastAmrA.forward_patches)}`)
			console.log(`Row B Final Patches: ${JSON.stringify(lastAmrB.forward_patches)}`)
			return false
		}
	}

	return true // All final states match
}
