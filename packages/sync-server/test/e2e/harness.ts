import { HttpApp, HttpRouter, KeyValueStore } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { RpcSerialization, RpcServer } from "@effect/rpc"
import { SqlClient } from "@effect/sql"
import { PgliteClient } from "@effect/sql-pglite"
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp"
import { initializeDatabaseSchema } from "@synchrotron/sync-core/db"
import { SyncNetworkRpcGroup } from "@synchrotron/sync-core/SyncNetworkRpc"
import { ConfigProvider, Effect, Layer } from "effect"
import { createServer } from "node:http"
import { SyncNetworkRpcHandlersLive } from "../../src/rpcRouter"
import { createSyncSnapshotConfig } from "../../src/SyncSnapshotConfig"

export const makeServerSqlLayer = (dataDir: string) => {
	const PgliteClientLive = PgliteClient.layer({
		dataDir,
		relaxedDurability: true,
		extensions: { uuid_ossp }
	}).pipe(Layer.fresh)

	const BaseLayer = Layer.mergeAll(PgliteClientLive, KeyValueStore.layerMemory)

	return BaseLayer
}

export const setupServerDatabase = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient

	// Sync schema + server-side rollback/apply functions.
	yield* initializeDatabaseSchema

	// Shared-row example schema (used by e2e sync assertions).
	yield* sql`CREATE SCHEMA IF NOT EXISTS synchrotron`

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

	// Notes are scoped to a project; audience_key is derived from project_id.
	yield* sql`
		CREATE TABLE IF NOT EXISTS notes (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			audience_key TEXT GENERATED ALWAYS AS ('project:' || project_id) STORED
		);
	`

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
				CREATE ROLE synchrotron_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
			END IF;
		END $$;
	`

	yield* sql`GRANT USAGE ON SCHEMA public TO synchrotron_app`
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE action_records TO synchrotron_app`
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE action_modified_rows TO synchrotron_app`
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE local_applied_action_ids TO synchrotron_app`
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE client_sync_status TO synchrotron_app`
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sync_server_meta TO synchrotron_app`
	yield* sql`GRANT USAGE ON SCHEMA synchrotron TO synchrotron_app`
	yield* sql`GRANT SELECT ON TABLE synchrotron.user_audiences TO synchrotron_app`.raw
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE projects TO synchrotron_app`
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE project_members TO synchrotron_app`
	yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notes TO synchrotron_app`
	yield* sql`GRANT USAGE, SELECT ON SEQUENCE action_records_server_ingest_id_seq TO synchrotron_app`
	yield* sql`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO synchrotron_app`

	// Sync tables RLS
	yield* sql`ALTER TABLE action_records ENABLE ROW LEVEL SECURITY`
	yield* sql`ALTER TABLE action_modified_rows ENABLE ROW LEVEL SECURITY`

	// NOTE: pglite currently fails RLS WITH CHECK evaluation for parameterized inserts in some cases.
	// For our test harness we keep INSERT policies permissive and rely on:
	// - server-side auth-derived user_id assignment (client can't spoof user_id)
	// - app table RLS (notes) to reject unauthorized patch application
	// while still enforcing SELECT filtering on the sync log tables.
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
	`

	yield* sql`
		CREATE POLICY synchrotron_action_modified_rows_insert ON action_modified_rows
			FOR INSERT
			WITH CHECK (true)
	`

	// Example app table RLS
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

export const makeSyncRpcServerLayer = (options: { readonly dataDir: string }) => {
	const dbLayer = makeServerSqlLayer(options.dataDir).pipe(
		Layer.tap((context) => setupServerDatabase.pipe(Effect.provide(context)))
	)

	const HttpProtocol = RpcServer.layerProtocolHttp({
		path: "/rpc"
	}).pipe(Layer.provideMerge(RpcSerialization.layerJson))

	const RpcLayer = RpcServer.layer(SyncNetworkRpcGroup).pipe(
		Layer.provideMerge(SyncNetworkRpcHandlersLive),
		Layer.provideMerge(HttpProtocol)
	)

	return HttpRouter.Default.serve().pipe(
		Layer.provide(RpcLayer),
		Layer.provide(dbLayer),
		Layer.provide(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" }))
	)
}

export const TestSyncRpcBaseUrl = "http://synchrotron.test"

export const makeInProcessSyncRpcServer = (options: {
	readonly dataDir: string
	readonly configProvider: ConfigProvider.ConfigProvider
	readonly baseUrl?: string
}) =>
	Effect.gen(function* () {
		const dbLayer = makeServerSqlLayer(options.dataDir)
		const servicesLayer = SyncNetworkRpcHandlersLive.pipe(Layer.provideMerge(dbLayer))

		const serverLayer = Layer.mergeAll(
			servicesLayer,
			RpcSerialization.layerJson,
			createSyncSnapshotConfig(["notes"])
		)

		const runtime = yield* Layer.toRuntime(serverLayer).pipe(
			Effect.withConfigProvider(options.configProvider)
		)

		yield* setupServerDatabase.pipe(Effect.provide(runtime))

		const rpcHttpApp = yield* RpcServer.toHttpApp(SyncNetworkRpcGroup).pipe(Effect.provide(runtime))
		const handler = HttpApp.toWebHandlerRuntime(runtime)(rpcHttpApp)

		return {
			baseUrl: options.baseUrl ?? TestSyncRpcBaseUrl,
			runtime,
			handler
		} as const
	})
