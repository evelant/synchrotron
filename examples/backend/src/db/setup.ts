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
	yield* sql`GRANT USAGE ON SCHEMA public TO synchrotron_app`.raw
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE action_records TO synchrotron_app`.raw
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE action_modified_rows TO synchrotron_app`.raw
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE local_applied_action_ids TO synchrotron_app`.raw
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE client_sync_status TO synchrotron_app`.raw
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE todos TO synchrotron_app`.raw
	yield* sql`GRANT USAGE, SELECT ON SEQUENCE action_records_server_ingest_id_seq TO synchrotron_app`.raw
	yield* sql`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO synchrotron_app`.raw
})

const enableExampleRlsPolicies = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient

	// Sync tables
	yield* sql`ALTER TABLE action_records ENABLE ROW LEVEL SECURITY`.raw
	yield* sql`ALTER TABLE action_modified_rows ENABLE ROW LEVEL SECURITY`.raw

	yield* sql`DROP POLICY IF EXISTS synchrotron_action_records_user ON action_records`.raw
	yield* sql`
		CREATE POLICY synchrotron_action_records_user ON action_records
			USING (user_id = current_setting('synchrotron.user_id', true))
			WITH CHECK (user_id = current_setting('synchrotron.user_id', true))
	`.raw

	yield* sql`DROP POLICY IF EXISTS synchrotron_action_modified_rows_user ON action_modified_rows`.raw
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
	`.raw

	// Example app table
	yield* sql`ALTER TABLE todos ENABLE ROW LEVEL SECURITY`.raw
	yield* sql`DROP POLICY IF EXISTS todo_owner_policy ON todos`.raw
	yield* sql`
		CREATE POLICY todo_owner_policy ON todos
			USING (owner_id = current_setting('synchrotron.user_id', true))
			WITH CHECK (owner_id = current_setting('synchrotron.user_id', true))
	`.raw
})

const createTodoTables = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	yield* sql`
		CREATE TABLE IF NOT EXISTS todos (
			id TEXT PRIMARY KEY,
			text TEXT NOT NULL,
			completed BOOLEAN NOT NULL DEFAULT FALSE,
			owner_id TEXT NOT NULL
		);
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
