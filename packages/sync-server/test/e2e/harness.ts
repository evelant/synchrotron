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

	// Example app table (used by e2e sync assertions).
	yield* sql`
		CREATE TABLE IF NOT EXISTS notes (
			id TEXT PRIMARY KEY,
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

	// Sync tables RLS
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

	// Example app table RLS
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

		const serverLayer = Layer.mergeAll(servicesLayer, RpcSerialization.layerJson)

		const runtime = yield* Layer.toRuntime(serverLayer).pipe(Effect.withConfigProvider(options.configProvider))

		yield* setupServerDatabase.pipe(Effect.provide(runtime))

		const rpcHttpApp = yield* RpcServer.toHttpApp(SyncNetworkRpcGroup).pipe(Effect.provide(runtime))
		const handler = HttpApp.toWebHandlerRuntime(runtime)(rpcHttpApp)

		return {
			baseUrl: options.baseUrl ?? TestSyncRpcBaseUrl,
			runtime,
			handler
		} as const
	})
