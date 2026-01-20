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
		CREATE SCHEMA IF NOT EXISTS synchrotron;
	`

	yield* sql`
		CREATE TABLE IF NOT EXISTS projects (
			id TEXT PRIMARY KEY
		);
	`

	yield* sql`
		CREATE TABLE IF NOT EXISTS project_members (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			user_id TEXT NOT NULL,
			audience_key TEXT GENERATED ALWAYS AS ('project:' || project_id) STORED,
			UNIQUE (project_id, user_id)
		);
	`

	yield* sql`
		CREATE TABLE IF NOT EXISTS notes (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			content TEXT NOT NULL,
			project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			audience_key TEXT GENERATED ALWAYS AS ('project:' || project_id) STORED
		);
	`

	yield* sql`
		CREATE OR REPLACE VIEW synchrotron.user_audiences AS
		SELECT user_id, audience_key
		FROM project_members
	`.raw

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
	yield* sql`GRANT USAGE ON SCHEMA synchrotron TO synchrotron_app`
	yield* sql`GRANT SELECT ON TABLE synchrotron.user_audiences TO synchrotron_app`.raw
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE projects TO synchrotron_app`
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE project_members TO synchrotron_app`
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notes TO synchrotron_app`
	yield* sql`GRANT USAGE, SELECT ON SEQUENCE action_records_server_ingest_id_seq TO synchrotron_app`
	yield* sql`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO synchrotron_app`

	// Sync tables
	yield* sql`ALTER TABLE action_records ENABLE ROW LEVEL SECURITY`
	yield* sql`ALTER TABLE action_modified_rows ENABLE ROW LEVEL SECURITY`

	// NOTE: pglite currently fails RLS WITH CHECK evaluation for parameterized inserts in some cases.
	// Keep INSERT policies permissive for sync log tables in tests; rely on app table RLS for enforcement.
	yield* sql`DROP POLICY IF EXISTS synchrotron_action_records_select ON action_records`
	yield* sql`DROP POLICY IF EXISTS synchrotron_action_records_insert ON action_records`
	yield* sql`
		CREATE POLICY synchrotron_action_records_select ON action_records
			FOR SELECT
			USING (
				(
					current_setting('synchrotron.internal_materializer', true) = 'true'
					AND current_user = 'synchrotron_app'
				)
				OR
				(
					-- Allow inserting new action_records before their AMRs are inserted (pglite RLS quirk).
					action_records.user_id = current_setting('synchrotron.user_id', true)
					AND NOT EXISTS (
						SELECT 1
						FROM action_modified_rows amr
						WHERE amr.action_record_id = action_records.id
					)
				)
				OR EXISTS (
					SELECT 1
					FROM action_modified_rows amr
					JOIN synchrotron.user_audiences a
						ON a.audience_key = amr.audience_key
					WHERE a.user_id = current_setting('synchrotron.user_id', true)
					AND amr.action_record_id = action_records.id
				)
			)
	`

	yield* sql`
		CREATE POLICY synchrotron_action_records_insert ON action_records
			FOR INSERT
			WITH CHECK (true)
	`

	yield* sql`DROP POLICY IF EXISTS synchrotron_action_modified_rows_select ON action_modified_rows`
	yield* sql`DROP POLICY IF EXISTS synchrotron_action_modified_rows_insert ON action_modified_rows`
	yield* sql`
		CREATE POLICY synchrotron_action_modified_rows_select ON action_modified_rows
			FOR SELECT
			USING (
				(
					current_setting('synchrotron.internal_materializer', true) = 'true'
					AND current_user = 'synchrotron_app'
				)
				OR
				EXISTS (
					SELECT 1
					FROM synchrotron.user_audiences a
					WHERE a.user_id = current_setting('synchrotron.user_id', true)
					AND a.audience_key = action_modified_rows.audience_key
				)
			)
	`

	yield* sql`
		CREATE POLICY synchrotron_action_modified_rows_insert ON action_modified_rows
			FOR INSERT
			WITH CHECK (true)
	`

	// Example app table
	yield* sql`ALTER TABLE notes ENABLE ROW LEVEL SECURITY`
	yield* sql`DROP POLICY IF EXISTS notes_user_policy ON notes`
	yield* sql`
		CREATE POLICY notes_user_policy ON notes
			USING (
				EXISTS (
					SELECT 1
					FROM synchrotron.user_audiences a
					WHERE a.user_id = current_setting('synchrotron.user_id', true)
					AND a.audience_key = notes.audience_key
				)
			)
			WITH CHECK (
				EXISTS (
					SELECT 1
					FROM synchrotron.user_audiences a
					WHERE a.user_id = current_setting('synchrotron.user_id', true)
					AND a.audience_key = notes.audience_key
				)
			)
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
		"filters action fetch by audience membership (RLS on sync tables)",
		() =>
			Effect.gen(function* () {
				yield* setupRlsDatabase

				const sql = yield* SqlClient.SqlClient
				const server = yield* SyncServerService

				const projectA = `project-${crypto.randomUUID()}`
				const projectB = `project-${crypto.randomUUID()}`
				const memberAId = `${projectA}-userA`
				const memberBId = `${projectB}-userB`

				yield* sql`INSERT INTO projects (id) VALUES (${projectA}), (${projectB})`
				yield* sql`
					INSERT INTO project_members (id, project_id, user_id)
					VALUES (${memberAId}, ${projectA}, 'userA'), (${memberBId}, ${projectB}, 'userB')
				`

				const actionAId = crypto.randomUUID()
				const actionBId = crypto.randomUUID()
				const noteAId = crypto.randomUUID()
				const noteBId = crypto.randomUUID()

				yield* server
					.receiveActions(
						"clientA",
						0,
						[makeTestAction({ id: actionAId, clientId: "clientA", clockTimeMs: 1000, clockCounter: 1 })],
						[
							{
								id: crypto.randomUUID(),
								table_name: "notes",
								row_id: noteAId,
								action_record_id: actionAId,
								audience_key: `project:${projectA}`,
								operation: "INSERT",
								forward_patches: {
									id: noteAId,
									title: "A",
									content: "visible-to-userA",
									project_id: projectA
								},
								reverse_patches: {},
								sequence: 0
							}
						]
					)
					.pipe(Effect.provideService(SyncUserId, "userA" as UserId))

				yield* server
					.receiveActions(
						"clientB",
						0,
						[makeTestAction({ id: actionBId, clientId: "clientB", clockTimeMs: 2000, clockCounter: 1 })],
						[
							{
								id: crypto.randomUUID(),
								table_name: "notes",
								row_id: noteBId,
								action_record_id: actionBId,
								audience_key: `project:${projectB}`,
								operation: "INSERT",
								forward_patches: {
									id: noteBId,
									title: "B",
									content: "visible-to-userB",
									project_id: projectB
								},
								reverse_patches: {},
								sequence: 0
							}
						]
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

				const sql = yield* SqlClient.SqlClient
				const server = yield* SyncServerService

				const projectA = `project-${crypto.randomUUID()}`
				const memberAId = `${projectA}-userA`
				yield* sql`INSERT INTO projects (id) VALUES (${projectA})`
				yield* sql`
					INSERT INTO project_members (id, project_id, user_id)
					VALUES (${memberAId}, ${projectA}, 'userA')
				`

				const actionAId = crypto.randomUUID()
				const actionBId = crypto.randomUUID()
				const noteAId = crypto.randomUUID()
				const noteBId = crypto.randomUUID()

				yield* server
					.receiveActions(
						"clientA",
						0,
						[makeTestAction({ id: actionAId, clientId: "clientA", clockTimeMs: 1000, clockCounter: 1 })],
						[
							{
								id: crypto.randomUUID(),
								table_name: "notes",
								row_id: noteAId,
								action_record_id: actionAId,
								audience_key: `project:${projectA}`,
								operation: "INSERT",
								forward_patches: {
									id: noteAId,
									title: "A",
									content: "one",
									project_id: projectA
								},
								reverse_patches: {},
								sequence: 0
							}
						]
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
						[
							{
								id: crypto.randomUUID(),
								table_name: "notes",
								row_id: noteBId,
								action_record_id: actionBId,
								audience_key: `project:${projectA}`,
								operation: "INSERT",
								forward_patches: {
									id: noteBId,
									title: "B",
									content: "two",
									project_id: projectA
								},
								reverse_patches: {},
								sequence: 0
							}
						]
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
		"rejects patch apply that violates RLS WITH CHECK (notes audience membership)",
		() =>
			Effect.gen(function* () {
				yield* setupRlsDatabase

				const sql = yield* SqlClient.SqlClient
				const server = yield* SyncServerService

				const actionId = crypto.randomUUID()
				const noteId = crypto.randomUUID()
				const projectId = `project-${crypto.randomUUID()}`

				yield* sql`INSERT INTO projects (id) VALUES (${projectId})`
				// Note: userA is NOT a member of this project.

				const action = makeTestAction({ id: actionId, clientId: "clientA", clockTimeMs: 1000, clockCounter: 1 })
				const amr: ActionModifiedRow = {
					id: crypto.randomUUID(),
					table_name: "notes",
					row_id: noteId,
					action_record_id: actionId,
					audience_key: `project:${projectId}`,
					operation: "INSERT",
					forward_patches: {
						id: noteId,
						title: "Forbidden",
						content: "",
						project_id: projectId
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

	it.scoped(
		"does not allow sync-log RLS bypass without the server DB role (internal_materializer guardrail)",
		() =>
			Effect.gen(function* () {
				yield* setupRlsDatabase

				const sql = yield* SqlClient.SqlClient
				const server = yield* SyncServerService

				const projectA = `project-${crypto.randomUUID()}`
				const projectB = `project-${crypto.randomUUID()}`
				const memberAId = `${projectA}-userA`
				const memberBId = `${projectB}-userB`

				yield* sql`INSERT INTO projects (id) VALUES (${projectA}), (${projectB})`
				yield* sql`
					INSERT INTO project_members (id, project_id, user_id)
					VALUES (${memberAId}, ${projectA}, 'userA'), (${memberBId}, ${projectB}, 'userB')
					ON CONFLICT DO NOTHING
				`

				const actionAId = crypto.randomUUID()
				const actionBId = crypto.randomUUID()
				const noteAId = crypto.randomUUID()
				const noteBId = crypto.randomUUID()

				yield* server
					.receiveActions(
						"clientA",
						0,
						[makeTestAction({ id: actionAId, clientId: "clientA", clockTimeMs: 1000, clockCounter: 1 })],
						[
							{
								id: crypto.randomUUID(),
								table_name: "notes",
								row_id: noteAId,
								action_record_id: actionAId,
								audience_key: `project:${projectA}`,
								operation: "INSERT",
								forward_patches: {
									id: noteAId,
									title: "A",
									content: "",
									project_id: projectA
								},
								reverse_patches: {},
								sequence: 0
							}
						]
					)
					.pipe(Effect.provideService(SyncUserId, "userA" as UserId))

				yield* server
					.receiveActions(
						"clientB",
						0,
						[makeTestAction({ id: actionBId, clientId: "clientB", clockTimeMs: 2000, clockCounter: 1 })],
						[
							{
								id: crypto.randomUUID(),
								table_name: "notes",
								row_id: noteBId,
								action_record_id: actionBId,
								audience_key: `project:${projectB}`,
								operation: "INSERT",
								forward_patches: {
									id: noteBId,
									title: "B",
									content: "",
									project_id: projectB
								},
								reverse_patches: {},
								sequence: 0
							}
						]
					)
					.pipe(Effect.provideService(SyncUserId, "userB" as UserId))

				// Create a second non-bypass role that can SELECT the sync tables, but should never
				// be able to activate the internal materializer bypass (guardrail is `current_user`).
				yield* sql`RESET ROLE`
				yield* sql`
					DO $$
					BEGIN
						IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synchrotron_untrusted') THEN
							CREATE ROLE synchrotron_untrusted NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
						END IF;
					END $$;
				`
				yield* sql`GRANT USAGE ON SCHEMA public TO synchrotron_untrusted`
				yield* sql`GRANT USAGE ON SCHEMA synchrotron TO synchrotron_untrusted`
				yield* sql`GRANT SELECT ON TABLE action_records TO synchrotron_untrusted`
				yield* sql`GRANT SELECT ON TABLE action_modified_rows TO synchrotron_untrusted`
				yield* sql`GRANT SELECT ON TABLE synchrotron.user_audiences TO synchrotron_untrusted`.raw

				const readAllActionIdsAsUserA = Effect.gen(function* () {
					yield* sql`SELECT set_config('synchrotron.user_id', 'userA', true)`
					yield* sql`SELECT set_config('synchrotron.internal_materializer', 'true', true)`
					const rows = yield* sql<{ readonly id: string }>`
						SELECT id
						FROM action_records
						ORDER BY id ASC
					`
					return rows.map((r) => r.id)
				}).pipe(sql.withTransaction)

				yield* sql`SET ROLE synchrotron_app`
				const asServer = yield* readAllActionIdsAsUserA
				expect(new Set(asServer)).toEqual(new Set([actionAId, actionBId]))

				yield* sql`SET ROLE synchrotron_untrusted`
				const asUntrusted = yield* readAllActionIdsAsUserA
				expect(new Set(asUntrusted)).toEqual(new Set([actionAId]))
			}).pipe(Effect.provide(TestLayer)),
		{ timeout: 30000 }
	)

	it.scoped(
		"replays membership changes in-history during late arrival rollback+replay (Option A)",
		() =>
			Effect.gen(function* () {
				yield* setupRlsDatabase

				const sql = yield* SqlClient.SqlClient
				const server = yield* SyncServerService

				const projectId = `project-${crypto.randomUUID()}`
				const memberAId = `${projectId}-userA`
				const memberBId = `${projectId}-userB`

				yield* sql`INSERT INTO projects (id) VALUES (${projectId})`
				yield* sql`
					INSERT INTO project_members (id, project_id, user_id)
					VALUES (${memberAId}, ${projectId}, 'userA'), (${memberBId}, ${projectId}, 'userB')
					ON CONFLICT DO NOTHING
				`

				// Project membership is part of canonical history for Option A; enforce it with RLS so
				// server rollback+replay must apply membership patches under the originating principal.
				yield* sql`RESET ROLE`
				yield* sql`ALTER TABLE project_members ENABLE ROW LEVEL SECURITY`
				yield* sql`DROP POLICY IF EXISTS project_members_self_select ON project_members`.raw
				yield* sql`DROP POLICY IF EXISTS project_members_admin_all ON project_members`.raw
				yield* sql`
					CREATE POLICY project_members_self_select ON project_members
						FOR SELECT
						USING (user_id = current_setting('synchrotron.user_id', true))
				`
				yield* sql`
					CREATE POLICY project_members_admin_all ON project_members
						FOR ALL
						USING (current_setting('synchrotron.user_id', true) = 'userB')
						WITH CHECK (current_setting('synchrotron.user_id', true) = 'userB')
				`
				yield* sql`SET ROLE synchrotron_app`

				const noteEarlyId = crypto.randomUUID()
				const noteLateId = crypto.randomUUID()

				const createNoteActionId = crypto.randomUUID()
				yield* server
					.receiveActions(
						"clientA",
						0,
						[
							makeTestAction({
								id: createNoteActionId,
								clientId: "clientA",
								clockTimeMs: 1000,
								clockCounter: 1
							})
						],
						[
							{
								id: crypto.randomUUID(),
								table_name: "notes",
								row_id: noteEarlyId,
								action_record_id: createNoteActionId,
								audience_key: `project:${projectId}`,
								operation: "INSERT",
								forward_patches: {
									id: noteEarlyId,
									title: "Early",
									content: "created-before-revocation",
									project_id: projectId
								},
								reverse_patches: {},
								sequence: 0
							}
						]
					)
					.pipe(Effect.provideService(SyncUserId, "userA" as UserId))

				const headForClientB = yield* server
					.getActionsSince("clientB", 0, true)
					.pipe(Effect.provideService(SyncUserId, "userB" as UserId))
				const basisForClientB = headForClientB.actions[headForClientB.actions.length - 1]?.server_ingest_id
				expect(basisForClientB).not.toBeNull()
				expect(basisForClientB).not.toBeUndefined()
				if (basisForClientB === null || basisForClientB === undefined) return

				const revokeMembershipActionId = crypto.randomUUID()
				yield* server
					.receiveActions(
						"clientB",
						basisForClientB,
						[
							makeTestAction({
								id: revokeMembershipActionId,
								clientId: "clientB",
								clockTimeMs: 4000,
								clockCounter: 1
							})
						],
						[
							{
								id: crypto.randomUUID(),
								table_name: "project_members",
								row_id: memberAId,
								action_record_id: revokeMembershipActionId,
								audience_key: `project:${projectId}`,
								operation: "DELETE",
								forward_patches: {},
								reverse_patches: {
									project_id: projectId,
									user_id: "userA"
								},
								sequence: 0
							}
						]
					)
					.pipe(Effect.provideService(SyncUserId, "userB" as UserId))

				// Late-arriving action by userA, authored before the revocation, uploaded after.
				const lateNoteActionId = crypto.randomUUID()
				yield* server
					.receiveActions(
						"clientA",
						0,
						[
							makeTestAction({
								id: lateNoteActionId,
								clientId: "clientA",
								clockTimeMs: 2000,
								clockCounter: 1
							})
						],
						[
							{
								id: crypto.randomUUID(),
								table_name: "notes",
								row_id: noteLateId,
								action_record_id: lateNoteActionId,
								audience_key: `project:${projectId}`,
								operation: "INSERT",
								forward_patches: {
									id: noteLateId,
									title: "Late",
									content: "authored-before-revocation-uploaded-after",
									project_id: projectId
								},
								reverse_patches: {},
								sequence: 0
							}
						]
					)
					.pipe(Effect.provideService(SyncUserId, "userA" as UserId))

				yield* sql`SELECT set_config('synchrotron.user_id', 'userB', false)`
				const visibleToUserB = yield* sql<{ readonly id: string }>`
					SELECT id FROM notes ORDER BY id ASC
				`.pipe(Effect.map((rows) => rows.map((r) => r.id)))
				expect(new Set(visibleToUserB)).toEqual(new Set([noteEarlyId, noteLateId]))

				const userAMembershipRows = yield* sql<{ readonly count: number | string }>`
					SELECT count(*)::int as count
					FROM project_members
					WHERE id = ${memberAId}
				`.pipe(Effect.map((rows) => rows[0]?.count ?? 0))
				expect(Number(userAMembershipRows)).toBe(0)

				yield* sql`SELECT set_config('synchrotron.user_id', 'userA', false)`
				const visibleToUserA = yield* sql<{ readonly count: number | string }>`
					SELECT count(*)::int as count
					FROM notes
				`.pipe(Effect.map((rows) => rows[0]?.count ?? 0))
				expect(Number(visibleToUserA)).toBe(0)
			}).pipe(Effect.provide(TestLayer)),
		{ timeout: 30000 }
	)

	it.scoped(
		"fails if membership changes out-of-band (not replayable) and a late arrival requires rollback+replay",
		() =>
			Effect.gen(function* () {
				yield* setupRlsDatabase

				const sql = yield* SqlClient.SqlClient
				const server = yield* SyncServerService

				const projectId = `project-${crypto.randomUUID()}`
				const memberAId = `${projectId}-userA`
				const memberBId = `${projectId}-userB`

				yield* sql`INSERT INTO projects (id) VALUES (${projectId})`
				yield* sql`
					INSERT INTO project_members (id, project_id, user_id)
					VALUES (${memberAId}, ${projectId}, 'userA'), (${memberBId}, ${projectId}, 'userB')
					ON CONFLICT DO NOTHING
				`

				yield* sql`RESET ROLE`
				yield* sql`ALTER TABLE project_members ENABLE ROW LEVEL SECURITY`
				yield* sql`DROP POLICY IF EXISTS project_members_self_select ON project_members`.raw
				yield* sql`DROP POLICY IF EXISTS project_members_admin_all ON project_members`.raw
				yield* sql`
					CREATE POLICY project_members_self_select ON project_members
						FOR SELECT
						USING (user_id = current_setting('synchrotron.user_id', true))
				`
				yield* sql`
					CREATE POLICY project_members_admin_all ON project_members
						FOR ALL
						USING (current_setting('synchrotron.user_id', true) = 'userB')
						WITH CHECK (current_setting('synchrotron.user_id', true) = 'userB')
				`
				yield* sql`SET ROLE synchrotron_app`

				const noteEarlyId = crypto.randomUUID()
				const noteLateId = crypto.randomUUID()
				const noteByUserBId = crypto.randomUUID()

				const createNoteActionId = crypto.randomUUID()
				yield* server
					.receiveActions(
						"clientA",
						0,
						[
							makeTestAction({
								id: createNoteActionId,
								clientId: "clientA",
								clockTimeMs: 1000,
								clockCounter: 1
							})
						],
						[
							{
								id: crypto.randomUUID(),
								table_name: "notes",
								row_id: noteEarlyId,
								action_record_id: createNoteActionId,
								audience_key: `project:${projectId}`,
								operation: "INSERT",
								forward_patches: {
									id: noteEarlyId,
									title: "Early",
									content: "created-before-out-of-band-revocation",
									project_id: projectId
								},
								reverse_patches: {},
								sequence: 0
							}
						]
					)
					.pipe(Effect.provideService(SyncUserId, "userA" as UserId))

				const headForClientB = yield* server
					.getActionsSince("clientB", 0, true)
					.pipe(Effect.provideService(SyncUserId, "userB" as UserId))
				const basisForClientB = headForClientB.actions[headForClientB.actions.length - 1]?.server_ingest_id
				expect(basisForClientB).not.toBeNull()
				expect(basisForClientB).not.toBeUndefined()
				if (basisForClientB === null || basisForClientB === undefined) return

				// A later action by userB creates an applied frontier past the late-arriving action.
				const userBActionId = crypto.randomUUID()
				yield* server
					.receiveActions(
						"clientB",
						basisForClientB,
						[
							makeTestAction({
								id: userBActionId,
								clientId: "clientB",
								clockTimeMs: 4000,
								clockCounter: 1
							})
						],
						[
							{
								id: crypto.randomUUID(),
								table_name: "notes",
								row_id: noteByUserBId,
								action_record_id: userBActionId,
								audience_key: `project:${projectId}`,
								operation: "INSERT",
								forward_patches: {
									id: noteByUserBId,
									title: "UserB",
									content: "created-after",
									project_id: projectId
								},
								reverse_patches: {},
								sequence: 0
							}
						]
					)
					.pipe(Effect.provideService(SyncUserId, "userB" as UserId))

				// Out-of-band membership change: revoke userA directly in the base table (not via action log).
				yield* sql`SELECT set_config('synchrotron.user_id', 'userB', false)`
				yield* sql`DELETE FROM project_members WHERE id = ${memberAId}`

				// Now a late-arriving historical action by userA (authored before revocation) forces rollback+replay,
				// but the server cannot restore membership because it wasn't part of history.
				const lateNoteActionId = crypto.randomUUID()
				const exit = yield* Effect.exit(
					server
						.receiveActions(
							"clientA",
							0,
							[
								makeTestAction({
									id: lateNoteActionId,
									clientId: "clientA",
									clockTimeMs: 2000,
									clockCounter: 1
								})
							],
							[
								{
									id: crypto.randomUUID(),
									table_name: "notes",
									row_id: noteLateId,
									action_record_id: lateNoteActionId,
									audience_key: `project:${projectId}`,
									operation: "INSERT",
									forward_patches: {
										id: noteLateId,
										title: "Late",
										content: "should-fail-without-replayable-membership",
										project_id: projectId
									},
									reverse_patches: {},
									sequence: 0
								}
							]
						)
						.pipe(Effect.provideService(SyncUserId, "userA" as UserId))
				)

				expect(exit._tag).toBe("Failure")
			}).pipe(Effect.provide(TestLayer)),
		{ timeout: 30000 }
	)
})
