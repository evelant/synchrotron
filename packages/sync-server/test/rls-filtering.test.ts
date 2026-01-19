import { KeyValueStore } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp"
import { initializeDatabaseSchema } from "@synchrotron/sync-core/db"
import type { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"
import { Effect, Layer } from "effect"
import { SyncServerService } from "../src/SyncServerService"
import type { UserId } from "../src/SyncUserId"
import { SyncUserId } from "../src/SyncUserId"

const PgliteClientLive = PgliteClient.layer({
	dataDir: "memory://",
	relaxedDurability: true,
	extensions: {
		uuid_ossp
	}
}).pipe(Layer.fresh)

// Bridge: @effect/sql-pglite provides its own SqlClient tag instance; provide the workspace tag
// used by sync-core/sync-server by aliasing the same client into `SqlClient.SqlClient`.
const SqlClientLive = Layer.effect(
	SqlClient.SqlClient,
	Effect.gen(function* () {
		const client = yield* PgliteClient.PgliteClient
		return client
	})
)

const BaseLayer = Layer.mergeAll(PgliteClientLive, KeyValueStore.layerMemory, Layer.scope)

const TestLayer = SyncServerService.Default.pipe(
	Layer.provideMerge(SqlClientLive),
	Layer.provideMerge(BaseLayer)
)

const setupRlsDatabase = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient

	yield* initializeDatabaseSchema

	yield* sql`
		CREATE TABLE IF NOT EXISTS notes (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			content TEXT NOT NULL,
			user_id TEXT NOT NULL
		);
	`

	// Create a dedicated non-superuser role so RLS is enforced.
	yield* sql`
		DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synchrotron_app') THEN
				CREATE ROLE synchrotron_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
			END IF;
		END $$;
	`

	yield* sql`GRANT USAGE ON SCHEMA public TO synchrotron_app`
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE action_records TO synchrotron_app`
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE action_modified_rows TO synchrotron_app`
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE local_applied_action_ids TO synchrotron_app`
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE client_sync_status TO synchrotron_app`
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notes TO synchrotron_app`
	yield* sql`GRANT USAGE, SELECT ON SEQUENCE action_records_server_ingest_id_seq TO synchrotron_app`
	yield* sql`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO synchrotron_app`

	// Sync tables
	yield* sql`ALTER TABLE action_records ENABLE ROW LEVEL SECURITY`
	yield* sql`ALTER TABLE action_modified_rows ENABLE ROW LEVEL SECURITY`

	yield* sql`DROP POLICY IF EXISTS synchrotron_action_records_user ON action_records`
	yield* sql`
		CREATE POLICY synchrotron_action_records_user ON action_records
			USING (user_id = current_setting('synchrotron.user_id', true))
			WITH CHECK (user_id = current_setting('synchrotron.user_id', true))
	`

	yield* sql`DROP POLICY IF EXISTS synchrotron_action_modified_rows_user ON action_modified_rows`
	yield* sql`
		CREATE POLICY synchrotron_action_modified_rows_user ON action_modified_rows
			USING (
				EXISTS (
					SELECT 1
					FROM action_records ar
					WHERE ar.id = action_record_id
					AND ar.user_id = current_setting('synchrotron.user_id', true)
				)
			)
			WITH CHECK (
				EXISTS (
					SELECT 1
					FROM action_records ar
					WHERE ar.id = action_record_id
					AND ar.user_id = current_setting('synchrotron.user_id', true)
				)
			)
	`

	// Example app table
	yield* sql`ALTER TABLE notes ENABLE ROW LEVEL SECURITY`
	yield* sql`DROP POLICY IF EXISTS notes_user_policy ON notes`
	yield* sql`
		CREATE POLICY notes_user_policy ON notes
			USING (user_id = current_setting('synchrotron.user_id', true))
			WITH CHECK (user_id = current_setting('synchrotron.user_id', true))
	`

	// Enforce RLS by switching to the limited role for the remainder of the session.
	yield* sql`SET ROLE synchrotron_app`
})

const makeTestAction = (params: {
	readonly id: string
	readonly clientId: string
	readonly clockTimeMs: number
	readonly clockCounter: number
}): ActionRecord =>
	({
		id: params.id,
		server_ingest_id: null,
		_tag: "TestAction",
		user_id: null,
		client_id: params.clientId,
		transaction_id: params.clockTimeMs,
		clock: {
			timestamp: params.clockTimeMs,
			vector: { [params.clientId]: params.clockCounter }
		},
		clock_time_ms: params.clockTimeMs,
		clock_counter: params.clockCounter,
		args: { timestamp: params.clockTimeMs },
		created_at: new Date(params.clockTimeMs),
		synced: false
	}) as unknown as ActionRecord

describe("Server RLS filtering", () => {
	it.scoped(
		"filters action fetch by user_id (RLS on sync tables)",
		() =>
			Effect.gen(function* () {
				yield* setupRlsDatabase

				const server = yield* SyncServerService

				const actionAId = crypto.randomUUID()
				const actionBId = crypto.randomUUID()

				yield* server
					.receiveActions(
						"clientA",
						0,
						[makeTestAction({ id: actionAId, clientId: "clientA", clockTimeMs: 1000, clockCounter: 1 })],
						[]
					)
					.pipe(Effect.provideService(SyncUserId, "userA" as UserId))

				yield* server
					.receiveActions(
						"clientB",
						0,
						[makeTestAction({ id: actionBId, clientId: "clientB", clockTimeMs: 2000, clockCounter: 1 })],
						[]
					)
					.pipe(Effect.provideService(SyncUserId, "userB" as UserId))

				const userAResult = yield* server
					.getActionsSince("clientA", 0, true)
					.pipe(Effect.provideService(SyncUserId, "userA" as UserId))

				expect(userAResult.actions.map((a) => a.id)).toEqual([actionAId])

				const userBResult = yield* server
					.getActionsSince("clientB", 0, true)
					.pipe(Effect.provideService(SyncUserId, "userB" as UserId))

				expect(userBResult.actions.map((a) => a.id)).toEqual([actionBId])
			}).pipe(Effect.provide(TestLayer)),
			{ timeout: 30000 }
	)

	it.scoped(
		"allows multi-client sync within the same user (includeSelf gate)",
		() =>
			Effect.gen(function* () {
				yield* setupRlsDatabase

				const server = yield* SyncServerService

				const actionAId = crypto.randomUUID()
				const actionBId = crypto.randomUUID()

				yield* server
					.receiveActions(
						"clientA",
						0,
						[makeTestAction({ id: actionAId, clientId: "clientA", clockTimeMs: 1000, clockCounter: 1 })],
						[]
					)
					.pipe(Effect.provideService(SyncUserId, "userA" as UserId))

				// Client B must be at the current head before uploading.
				const headForClientB = yield* server
					.getActionsSince("clientB", 0, true)
					.pipe(Effect.provideService(SyncUserId, "userA" as UserId))

				const latestVisible = headForClientB.actions[headForClientB.actions.length - 1]
				expect(latestVisible).toBeDefined()
				if (!latestVisible || latestVisible.server_ingest_id === null) return

				yield* server
					.receiveActions(
						"clientB",
						latestVisible.server_ingest_id,
						[makeTestAction({ id: actionBId, clientId: "clientB", clockTimeMs: 2000, clockCounter: 1 })],
						[]
					)
					.pipe(Effect.provideService(SyncUserId, "userA" as UserId))

				const fromClientA = yield* server
					.getActionsSince("clientA", 0, false)
					.pipe(Effect.provideService(SyncUserId, "userA" as UserId))
				expect(fromClientA.actions.map((a) => a.id)).toEqual([actionBId])

				const withSelfOnA = yield* server
					.getActionsSince("clientA", 0, true)
					.pipe(Effect.provideService(SyncUserId, "userA" as UserId))
				expect(withSelfOnA.actions.map((a) => a.id)).toEqual([actionAId, actionBId])

				const fromClientB = yield* server
					.getActionsSince("clientB", 0, false)
					.pipe(Effect.provideService(SyncUserId, "userA" as UserId))
				expect(fromClientB.actions.map((a) => a.id)).toEqual([actionAId])
			}).pipe(Effect.provide(TestLayer)),
		{ timeout: 30000 }
	)

	it.scoped(
		"rejects patch apply that violates RLS WITH CHECK (notes.user_id)",
		() =>
			Effect.gen(function* () {
				yield* setupRlsDatabase

				const sql = yield* SqlClient.SqlClient
				const server = yield* SyncServerService

				const actionId = crypto.randomUUID()
				const noteId = crypto.randomUUID()

				const action = makeTestAction({ id: actionId, clientId: "clientA", clockTimeMs: 1000, clockCounter: 1 })
				const amr: ActionModifiedRow = {
					id: crypto.randomUUID(),
					table_name: "notes",
					row_id: noteId,
					action_record_id: actionId,
					operation: "INSERT",
					forward_patches: {
						id: noteId,
						title: "Forbidden",
						content: "",
						user_id: "userB"
					},
					reverse_patches: {},
					sequence: 0
				}

				const exit = yield* Effect.exit(
					server
						.receiveActions("clientA", 0, [action], [amr])
						.pipe(Effect.provideService(SyncUserId, "userA" as UserId))
				)

				expect(exit._tag).toBe("Failure")

				// Ensure the transaction was fully rolled back (no partial log rows or base-table writes).
				yield* sql`RESET ROLE`

				const noteCount = yield* sql<{ readonly count: number }>`
					SELECT count(*)::int as count FROM notes
				`.pipe(Effect.map((rows) => rows[0]?.count ?? 0))

				expect(noteCount).toBe(0)

				const actionCount = yield* sql<{ readonly count: number }>`
					SELECT count(*)::int as count FROM action_records WHERE id = ${actionId}
				`.pipe(Effect.map((rows) => rows[0]?.count ?? 0))

				expect(actionCount).toBe(0)
			}).pipe(Effect.provide(TestLayer)),
		{ timeout: 30000 }
	)
})
