import { Model, SqlClient, SqlSchema } from "@effect/sql"
import { Effect, Option, Schema } from "effect" // Import Option
import { ActionRecord } from "./models"

/**
 * Repository service for ActionRecords with type-safe queries
 */
export class ActionRecordRepo extends Effect.Service<ActionRecordRepo>()("ActionRecordRepo", {
	effect: Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		const repo = yield* Model.makeRepository(ActionRecord, {
			tableName: "action_records",
			idColumn: "id",
			spanPrefix: "ActionRecordRepository"
		})

		const DbBoolean = Schema.transformOrFail(
			Schema.Union(Schema.Boolean, Schema.Literal(0, 1)),
			Schema.Boolean,
			{
				decode: (value) => Effect.succeed(typeof value === "boolean" ? value : value === 1),
				encode: (value) => Effect.succeed(value ? (1 as const) : (0 as const))
			}
		)

		const findBySynced = SqlSchema.findAll({
			Request: Schema.Boolean,
			Result: ActionRecord,
			execute: (synced) =>
				sql`SELECT * FROM action_records WHERE synced = ${synced ? 1 : 0} ORDER BY clock_time_ms ASC, clock_counter ASC, client_id ASC, id ASC`
		})

		const findByTag = SqlSchema.findAll({
			Request: Schema.String,
			Result: ActionRecord,
			execute: (tag) =>
				sql`SELECT * FROM action_records WHERE _tag = ${tag} ORDER BY clock_time_ms ASC, clock_counter ASC, client_id ASC, id ASC`
		})

		const findOlderThan = SqlSchema.findAll({
			Request: Schema.Number,
			Result: ActionRecord,
			execute: (days) => {
				const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000
				return sql`
					SELECT * FROM action_records
					WHERE clock_time_ms < ${cutoffMs}
					ORDER BY clock_time_ms ASC, clock_counter ASC, client_id ASC, id ASC
				`
			}
		})

		const findLatestSynced = SqlSchema.findOne({
			Request: Schema.Void,
			Result: ActionRecord,
			execute: () =>
				sql`SELECT * FROM action_records WHERE synced = 1 ORDER BY clock_time_ms DESC, clock_counter DESC, client_id DESC, id DESC LIMIT 1`
		})

		const findLatest = SqlSchema.findOne({
			Request: Schema.Void,
			Result: ActionRecord,
			execute: () =>
				sql`SELECT * FROM action_records ORDER BY clock_time_ms DESC, clock_counter DESC, client_id DESC, id DESC LIMIT 1`
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
				sql`SELECT * FROM action_records WHERE id IN ${sql.in(ids)} ORDER BY clock_time_ms ASC, clock_counter ASC, client_id ASC, id ASC`
		})

		const all = SqlSchema.findAll({
			Request: Schema.Void,
			Result: ActionRecord,
			execute: () =>
				sql`SELECT * FROM action_records ORDER BY clock_time_ms ASC, clock_counter ASC, client_id ASC, id ASC`
		})

		const allUnsynced = SqlSchema.findAll({
			Request: Schema.Void,
			Result: ActionRecord,
			execute: () =>
				sql`SELECT * FROM action_records WHERE synced = 0 ORDER BY clock_time_ms ASC, clock_counter ASC, client_id ASC, id ASC`
		})

		const markAsSynced = (id: string) =>
			sql`UPDATE action_records SET synced = 1 WHERE id = ${id}`

		const deleteById = (id: string) => sql`DELETE FROM action_records WHERE id = ${id}`

		const markLocallyApplied = (actionRecordId: string) =>
			sql`INSERT INTO local_applied_action_ids (action_record_id) VALUES (${actionRecordId}) ON CONFLICT DO NOTHING`

		const unmarkLocallyApplied = (actionRecordId: string) =>
			sql`DELETE FROM local_applied_action_ids WHERE action_record_id = ${actionRecordId}`

		const _isLocallyAppliedQuery = SqlSchema.findOne({
			Request: Schema.String,
			Result: Schema.Struct({ is_applied: DbBoolean }),
			execute: (actionRecordId) => sql`
				SELECT EXISTS (
					SELECT 1 FROM local_applied_action_ids WHERE action_record_id = ${actionRecordId}
				) as is_applied
			`
		})
		// Correctly handle the Option returned by findOne
		const isLocallyApplied = (actionRecordId: string) =>
			_isLocallyAppliedQuery(actionRecordId).pipe(
				Effect.map(Option.match({ onNone: () => false, onSome: (result) => result.is_applied }))
			)

		const findUnappliedLocally = SqlSchema.findAll({
			Request: Schema.Void,
			Result: ActionRecord,
			execute: () => sql`
				SELECT ar.*
				FROM action_records ar
				LEFT JOIN local_applied_action_ids la ON ar.id = la.action_record_id
				WHERE la.action_record_id IS NULL
				ORDER BY ar.clock_time_ms ASC, ar.clock_counter ASC, ar.client_id ASC, ar.id ASC
			`
		})

		const findSyncedButUnapplied = SqlSchema.findAll({
			Request: Schema.Void,
			Result: ActionRecord,
			execute: () => sql`
				SELECT ar.*
				FROM action_records ar
				LEFT JOIN local_applied_action_ids la ON ar.id = la.action_record_id
				WHERE la.action_record_id IS NULL
				AND ar.synced = 1
				AND ar.client_id != (SELECT client_id FROM client_sync_status LIMIT 1)
				ORDER BY ar.clock_time_ms ASC, ar.clock_counter ASC, ar.client_id ASC, ar.id ASC
			`
		})

		return {
			...repo,
			all,
			findBySynced,
			findByTransactionId,
			findLatestSynced,
			allUnsynced,
			findLatest,
			findByTag,
			findOlderThan,
			markAsSynced,
			findByIds,
			deleteById,
			// New methods
			markLocallyApplied,
			unmarkLocallyApplied,
			isLocallyApplied,
			findUnappliedLocally,
			findSyncedButUnapplied
		} as const
	}),
	dependencies: []
}) {}
