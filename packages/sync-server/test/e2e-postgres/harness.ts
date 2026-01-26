import { HttpApp, KeyValueStore } from "@effect/platform"
import { RpcSerialization, RpcServer } from "@effect/rpc"
import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { initializeDatabaseSchema } from "@synchrotron/sync-core/db"
import { SyncNetworkRpcGroup } from "@synchrotron/sync-core/SyncNetworkRpc"
import { Config, ConfigProvider, Effect, Layer, Redacted } from "effect"
import { SyncNetworkRpcHandlersLive } from "../../src/rpcRouter"
import { createSyncSnapshotConfig } from "../../src/SyncSnapshotConfig"

const createTestDatabaseName = () => `synchrotron_e2e_${crypto.randomUUID().replaceAll("-", "")}`

const withDatabase = (databaseUrl: string, databaseName: string) => {
	const url = new URL(databaseUrl)
	url.pathname = `/${databaseName}`
	return url.toString()
}

const DefaultAdminDatabaseUrl = "postgresql://postgres:password@127.0.0.1:56321/electric"
const DefaultDatabaseUrl = "postgresql://synchrotron_app:password@127.0.0.1:56321/electric"

const PostgresE2EUrls = Config.all({
	adminDatabaseUrl: Config.string("E2E_ADMIN_DATABASE_URL").pipe(
		Config.orElse(() => Config.string("ADMIN_DATABASE_URL")),
		Config.orElse(() => Config.succeed(DefaultAdminDatabaseUrl))
	),
	databaseUrl: Config.string("E2E_DATABASE_URL").pipe(
		Config.orElse(() => Config.string("DATABASE_URL")),
		Config.orElse(() => Config.succeed(DefaultDatabaseUrl))
	)
})

const setupServerDatabasePostgres = (params: { readonly databaseName: string }) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient

		// Required for gen_random_uuid() used by the sync schema functions and trigger helpers.
		yield* sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.raw

		// Sync schema + server-side rollback/apply functions.
		yield* initializeDatabaseSchema

		// Shared-row example schema (used by e2e sync assertions).
		yield* sql`CREATE SCHEMA IF NOT EXISTS synchrotron`.raw

		yield* sql`
			CREATE TABLE IF NOT EXISTS projects (
				id TEXT PRIMARY KEY
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

		// Notes are scoped to a project; audience_key is derived from project_id.
		yield* sql`
				CREATE TABLE IF NOT EXISTS notes (
					id TEXT PRIMARY KEY,
					content TEXT NOT NULL,
					project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
					audience_key TEXT GENERATED ALWAYS AS ('project:' || project_id) STORED
				);
			`.raw

		// Admin-only per-note metadata. This is used to exercise "private divergence" where a replica
		// with strictly more visibility emits a SYNC delta that should be filtered from other users.
		yield* sql`
					CREATE TABLE IF NOT EXISTS note_admin_meta (
						id TEXT PRIMARY KEY,
						-- Deferrable so server rollback+replay can temporarily violate FK order within a transaction.
						-- Final state is still enforced at COMMIT.
						note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
						last_seen_content TEXT NOT NULL,
						audience_key TEXT NOT NULL
					);
				`.raw

		// Convention: app-provided membership mapping for audience visibility.
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

		// Allow the app role to connect to the dynamically-created test database.
		yield* sql`GRANT CONNECT ON DATABASE ${sql(params.databaseName)} TO synchrotron_app`.raw

		yield* sql`GRANT USAGE ON SCHEMA public TO synchrotron_app`.raw
		yield* sql`GRANT USAGE ON SCHEMA synchrotron TO synchrotron_app`.raw

		yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE action_records TO synchrotron_app`.raw
		yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE action_modified_rows TO synchrotron_app`
			.raw
		yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE local_applied_action_ids TO synchrotron_app`
			.raw
		yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE client_sync_status TO synchrotron_app`
			.raw
		yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sync_server_meta TO synchrotron_app`
			.raw
		yield* sql`GRANT USAGE, SELECT ON SEQUENCE action_records_server_ingest_id_seq TO synchrotron_app`
			.raw
		yield* sql`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO synchrotron_app`.raw

		yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE projects TO synchrotron_app`.raw
		yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE project_members TO synchrotron_app`.raw
		yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notes TO synchrotron_app`.raw
		yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE note_admin_meta TO synchrotron_app`.raw
		yield* sql`GRANT SELECT ON TABLE synchrotron.user_audiences TO synchrotron_app`.raw

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

		// Sync tables RLS
		yield* sql`ALTER TABLE action_records ENABLE ROW LEVEL SECURITY`.raw
		yield* sql`ALTER TABLE action_modified_rows ENABLE ROW LEVEL SECURITY`.raw

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
					OR EXISTS (
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
					OR EXISTS (
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

		// Example app table RLS
		yield* sql`ALTER TABLE notes ENABLE ROW LEVEL SECURITY`.raw
		yield* sql`DROP POLICY IF EXISTS notes_user_policy ON notes`.raw
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
			`.raw

		yield* sql`ALTER TABLE note_admin_meta ENABLE ROW LEVEL SECURITY`.raw
		yield* sql`DROP POLICY IF EXISTS note_admin_meta_user_policy ON note_admin_meta`.raw
		yield* sql`
				CREATE POLICY note_admin_meta_user_policy ON note_admin_meta
					USING (
						EXISTS (
							SELECT 1
							FROM synchrotron.user_audiences a
							WHERE a.user_id = current_setting('synchrotron.user_id', true)
							AND a.audience_key = note_admin_meta.audience_key
						)
					)
					WITH CHECK (
						EXISTS (
							SELECT 1
							FROM synchrotron.user_audiences a
							WHERE a.user_id = current_setting('synchrotron.user_id', true)
							AND a.audience_key = note_admin_meta.audience_key
						)
					)
			`.raw
	})

export const makeInProcessSyncRpcServerPostgres = (options: {
	readonly configProvider: ConfigProvider.ConfigProvider
	readonly baseUrl?: string
}) =>
	Effect.gen(function* () {
		const baseUrl = options.baseUrl ?? "http://synchrotron.test"
		const databaseName = createTestDatabaseName()

		const urls = yield* options.configProvider.load(PostgresE2EUrls)

		const AdminClusterLive = PgClient.layer({
			url: Redacted.make(urls.adminDatabaseUrl),
			// Keep this 1 to avoid per-connection session state surprises in setup.
			maxConnections: 1
		}).pipe(Layer.fresh)

		// Create an isolated DB for this test run.
		yield* Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			yield* sql`CREATE DATABASE ${sql(databaseName)}`.raw
		}).pipe(Effect.provide(AdminClusterLive), Effect.scoped)

		const adminDbUrl = withDatabase(urls.adminDatabaseUrl, databaseName)
		const appDbUrl = withDatabase(urls.databaseUrl, databaseName)

		const AdminDbLive = PgClient.layer({
			url: Redacted.make(adminDbUrl),
			maxConnections: 1
		}).pipe(Layer.fresh)

		yield* setupServerDatabasePostgres({ databaseName }).pipe(
			Effect.provide(AdminDbLive),
			Effect.scoped
		)

		const AppDbLive = PgClient.layer({
			url: Redacted.make(appDbUrl),
			maxConnections: 10
		}).pipe(Layer.fresh)

		const servicesLayer = SyncNetworkRpcHandlersLive.pipe(
			Layer.provideMerge(Layer.mergeAll(AppDbLive, KeyValueStore.layerMemory))
		)
		const serverLayer = Layer.mergeAll(
			servicesLayer,
			RpcSerialization.layerJson,
			createSyncSnapshotConfig(["notes"])
		)

		const runtime = yield* Layer.toRuntime(serverLayer).pipe(
			Effect.withConfigProvider(options.configProvider)
		)
		const rpcHttpApp = yield* RpcServer.toHttpApp(SyncNetworkRpcGroup).pipe(Effect.provide(runtime))
		const handler = HttpApp.toWebHandlerRuntime(runtime)(rpcHttpApp)

		return {
			baseUrl,
			runtime,
			handler,
			databaseName,
			adminDbUrl,
			appDbUrl
		} as const
	})
