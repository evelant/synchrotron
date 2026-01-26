import { SqlClient } from "@effect/sql"
import { initializeDatabaseSchema } from "@synchrotron/sync-core"
import { Effect } from "effect"

const ensureExampleRlsRole = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient

	// Create a dedicated, non-superuser role for the RPC server so RLS is actually enforced.
	// (The docker Postgres user `postgres` would bypass RLS.)
	yield* sql`
		DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synchrotron_app') THEN
				CREATE ROLE synchrotron_app
					LOGIN
					PASSWORD 'password'
					NOSUPERUSER
					NOCREATEDB
					NOCREATEROLE
					NOBYPASSRLS;
			END IF;
		END $$;
	`.raw

	// Privileges for sync + example app tables.
	yield* sql`CREATE SCHEMA IF NOT EXISTS synchrotron`.raw

	yield* sql`GRANT USAGE ON SCHEMA public TO synchrotron_app`.raw
	yield* sql`GRANT USAGE ON SCHEMA synchrotron TO synchrotron_app`.raw
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE action_records TO synchrotron_app`.raw
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE action_modified_rows TO synchrotron_app`
		.raw
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE local_applied_action_ids TO synchrotron_app`
		.raw
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE client_sync_status TO synchrotron_app`
		.raw
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sync_server_meta TO synchrotron_app`.raw
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE projects TO synchrotron_app`.raw
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE project_members TO synchrotron_app`.raw
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE todos TO synchrotron_app`.raw
	yield* sql`GRANT SELECT ON TABLE synchrotron.user_audiences TO synchrotron_app`.raw
	yield* sql`GRANT USAGE, SELECT ON SEQUENCE action_records_server_ingest_id_seq TO synchrotron_app`
		.raw
	yield* sql`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO synchrotron_app`.raw
})

const enableExampleRlsPolicies = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient

	// Sync tables
	yield* sql`ALTER TABLE action_records ENABLE ROW LEVEL SECURITY`.raw
	yield* sql`ALTER TABLE action_modified_rows ENABLE ROW LEVEL SECURITY`.raw

	// Avoid RLS recursion when a sync-table policy needs to verify action_record ownership.
	// (SELECT policy on action_records references action_modified_rows; an insert policy on
	// action_modified_rows must not SELECT action_records through RLS.)
	yield* sql`
		CREATE OR REPLACE FUNCTION synchrotron.action_record_belongs_to_user(action_record_id TEXT, user_id TEXT)
		RETURNS BOOLEAN
		LANGUAGE sql
		STABLE
		SECURITY DEFINER
		SET search_path = public
		AS $$
			SELECT EXISTS (
				SELECT 1
				FROM action_records ar
				WHERE ar.id = $1
				AND ar.user_id = $2
			);
		$$;
	`.raw
	yield* sql`REVOKE ALL ON FUNCTION synchrotron.action_record_belongs_to_user(TEXT, TEXT) FROM PUBLIC`
		.raw
	yield* sql`GRANT EXECUTE ON FUNCTION synchrotron.action_record_belongs_to_user(TEXT, TEXT) TO synchrotron_app`
		.raw

	yield* sql`DROP POLICY IF EXISTS synchrotron_action_records_select ON action_records`.raw
	yield* sql`DROP POLICY IF EXISTS synchrotron_action_records_insert ON action_records`.raw
	yield* sql`
		CREATE POLICY synchrotron_action_records_select ON action_records
			FOR SELECT
			USING (
				(
					current_setting('synchrotron.internal_materializer', true) = 'true'
					AND current_user = 'synchrotron_app'
				)
				OR
				EXISTS (
					SELECT 1
					FROM action_modified_rows amr
					JOIN synchrotron.user_audiences a
						ON a.audience_key = amr.audience_key
					WHERE a.user_id = current_setting('synchrotron.user_id', true)
					AND amr.action_record_id = action_records.id
				)
			)
	`.raw

	yield* sql`
		CREATE POLICY synchrotron_action_records_insert ON action_records
			FOR INSERT
			WITH CHECK (user_id = current_setting('synchrotron.user_id', true))
	`.raw

	yield* sql`DROP POLICY IF EXISTS synchrotron_action_modified_rows_select ON action_modified_rows`
		.raw
	yield* sql`DROP POLICY IF EXISTS synchrotron_action_modified_rows_insert ON action_modified_rows`
		.raw
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
	`.raw

	yield* sql`
		CREATE POLICY synchrotron_action_modified_rows_insert ON action_modified_rows
			FOR INSERT
			WITH CHECK (
				synchrotron.action_record_belongs_to_user(
					action_modified_rows.action_record_id,
					current_setting('synchrotron.user_id', true)
				)
				AND EXISTS (
					SELECT 1
					FROM synchrotron.user_audiences a
					WHERE a.user_id = current_setting('synchrotron.user_id', true)
					AND a.audience_key = action_modified_rows.audience_key
				)
			)
	`.raw

	// Example app table
	yield* sql`ALTER TABLE projects ENABLE ROW LEVEL SECURITY`.raw
	yield* sql`ALTER TABLE project_members ENABLE ROW LEVEL SECURITY`.raw
	yield* sql`ALTER TABLE todos ENABLE ROW LEVEL SECURITY`.raw

	yield* sql`DROP POLICY IF EXISTS project_member_select ON projects`.raw
	yield* sql`
		CREATE POLICY project_member_select ON projects
			FOR SELECT
			USING (
				EXISTS (
					SELECT 1
					FROM project_members m
					WHERE m.project_id = projects.id
					AND m.user_id = current_setting('synchrotron.user_id', true)
				)
			)
	`.raw

	yield* sql`DROP POLICY IF EXISTS project_members_self_select ON project_members`.raw
	yield* sql`
		CREATE POLICY project_members_self_select ON project_members
			FOR SELECT
			USING (user_id = current_setting('synchrotron.user_id', true))
	`.raw

	yield* sql`DROP POLICY IF EXISTS todo_audience_policy ON todos`.raw
	yield* sql`
		CREATE POLICY todo_audience_policy ON todos
			USING (
				EXISTS (
					SELECT 1
					FROM synchrotron.user_audiences a
					WHERE a.user_id = current_setting('synchrotron.user_id', true)
					AND a.audience_key = todos.audience_key
				)
			)
			WITH CHECK (
				EXISTS (
					SELECT 1
					FROM synchrotron.user_audiences a
					WHERE a.user_id = current_setting('synchrotron.user_id', true)
					AND a.audience_key = todos.audience_key
				)
			)
	`.raw
})

const createTodoTables = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	yield* sql`CREATE SCHEMA IF NOT EXISTS synchrotron`.raw
	yield* sql`
		CREATE TABLE IF NOT EXISTS projects (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL DEFAULT ''
		);
	`.raw

	yield* sql`
		CREATE TABLE IF NOT EXISTS project_members (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			user_id TEXT NOT NULL,
			audience_key TEXT GENERATED ALWAYS AS ('project:' || project_id) STORED,
			UNIQUE (project_id, user_id)
		);
	`.raw

	yield* sql`
		CREATE OR REPLACE VIEW synchrotron.user_audiences AS
		SELECT user_id, audience_key
		FROM project_members
	`.raw

	yield* sql`
		CREATE TABLE IF NOT EXISTS todos (
			id TEXT PRIMARY KEY,
			text TEXT NOT NULL,
			completed BOOLEAN NOT NULL DEFAULT FALSE,
			project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			created_by TEXT NOT NULL,
			audience_key TEXT GENERATED ALWAYS AS ('project:' || project_id) STORED
		);
	`.raw

	// Seed a single demo project shared by two demo users.
	yield* sql`
		INSERT INTO projects (id, name)
		VALUES ('project-demo', 'Demo Project')
		ON CONFLICT (id) DO NOTHING
	`.raw
	yield* sql`
		INSERT INTO project_members (id, project_id, user_id)
		VALUES ('project-demo-user1', 'project-demo', 'user1'), ('project-demo-user2', 'project-demo', 'user2')
		ON CONFLICT DO NOTHING
	`.raw
})

export const setupServerDatabase = Effect.gen(function* () {
	yield* Effect.logInfo("Initializing server database schema...")
	yield* initializeDatabaseSchema
	yield* Effect.logInfo("Server sync schema initialized.")

	yield* createTodoTables
	yield* ensureExampleRlsRole
	yield* enableExampleRlsPolicies
	yield* Effect.logInfo("Server database setup complete.")
})
