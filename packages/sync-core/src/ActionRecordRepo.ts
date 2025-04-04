import { Model, SqlClient, SqlSchema } from "@effect/sql"
import { Effect, Option, Schema } from "effect" // Import Option
import { ActionRecord } from "./models"

/**
 * Repository service for ActionRecords with type-safe queries
 */
export class ActionRecordRepo extends Effect.Service<ActionRecordRepo>()("ActionRecordRepo", {
	effect: Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient

		// Create the base repository
		const repo = yield* Model.makeRepository(ActionRecord, {
			tableName: "action_records",
			idColumn: "id",
			spanPrefix: "ActionRecordRepository"
		})

		// --- Define type-safe queries ---

		const findBySynced = SqlSchema.findAll({
			Request: Schema.Boolean,
			Result: ActionRecord,
			execute: (synced) =>
				sql`SELECT * FROM action_records WHERE synced = ${synced} ORDER BY sortable_clock ASC`
		})

		const findByTag = SqlSchema.findAll({
			Request: Schema.String,
			Result: ActionRecord,
			execute: (tag) =>
				sql`SELECT * FROM action_records WHERE _tag = ${tag} ORDER BY sortable_clock ASC`
		})

		const findOlderThan = SqlSchema.findAll({
			Request: Schema.Number,
			Result: ActionRecord,
			execute: (days) => sql`
				SELECT * FROM action_records
				WHERE created_at < NOW() - INTERVAL '${days} days' 
				ORDER BY sortable_clock ASC
			`
		})

		const findLatestSynced = SqlSchema.findOne({
			Request: Schema.Void,
			Result: ActionRecord,
			execute: () =>
				sql`SELECT * FROM action_records WHERE synced = true ORDER BY sortable_clock DESC LIMIT 1`
		})

		const findByTransactionId = SqlSchema.findOne({
			Request: Schema.Number,
			Result: ActionRecord,
			execute: (txId) => sql`
				SELECT * FROM action_records
				WHERE transaction_id = ${txId}
			`
		})

		const findByIds = SqlSchema.findAll({
			Request: Schema.Array(Schema.String),
			Result: ActionRecord,
			execute: (ids) =>
				sql`SELECT * FROM action_records WHERE id IN ${sql.in(ids)} ORDER BY sortable_clock ASC`
		})

		const all = SqlSchema.findAll({
			Request: Schema.Void,
			Result: ActionRecord,
			execute: () => sql`SELECT * FROM action_records ORDER BY sortable_clock ASC`
		})

		const allUnsynced = SqlSchema.findAll({
			Request: Schema.Void,
			Result: ActionRecord,
			execute: () =>
				sql`SELECT * FROM action_records WHERE synced = false ORDER BY sortable_clock ASC`
		})

		// --- Define operations for modifying data ---

		const markAsSynced = (id: string) =>
			sql`UPDATE action_records SET synced = true WHERE id = ${id}`

		const deleteById = (id: string) => sql`DELETE FROM action_records WHERE id = ${id}`

		// --- New methods for local applied state ---

		const markLocallyApplied = (actionRecordId: string) =>
			sql`INSERT INTO local_applied_action_ids (action_record_id) VALUES (${actionRecordId}) ON CONFLICT DO NOTHING`

		const unmarkLocallyApplied = (actionRecordId: string) =>
			sql`DELETE FROM local_applied_action_ids WHERE action_record_id = ${actionRecordId}`

		const _isLocallyAppliedQuery = SqlSchema.findOne({
			Request: Schema.String,
			Result: Schema.Struct({ exists: Schema.Boolean }),
			execute: (actionRecordId) => sql`
				SELECT EXISTS (
					SELECT 1 FROM local_applied_action_ids WHERE action_record_id = ${actionRecordId}
				) as exists
			`
		})
		// Correctly handle the Option returned by findOne
		const isLocallyApplied = (actionRecordId: string) =>
			_isLocallyAppliedQuery(actionRecordId).pipe(
				Effect.map(Option.match({ onNone: () => false, onSome: (result) => result.exists }))
			)

		const findUnappliedLocally = SqlSchema.findAll({
			Request: Schema.Void,
			Result: ActionRecord,
			execute: () => sql`
				SELECT ar.*
				FROM action_records ar
				LEFT JOIN local_applied_action_ids la ON ar.id = la.action_record_id
				WHERE la.action_record_id IS NULL
				ORDER BY ar.sortable_clock ASC
			`
		})

		return {
			...repo,
			all,
			findBySynced,
			findByTransactionId,
			findLatestSynced,
			allUnsynced,
			findByTag,
			findOlderThan,
			markAsSynced,
			findByIds,
			deleteById,
			// New methods
			markLocallyApplied,
			unmarkLocallyApplied,
			isLocallyApplied,
			findUnappliedLocally
		} as const
	}),
	dependencies: []
}) {}
