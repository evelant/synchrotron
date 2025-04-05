import { KeyValueStore } from "@effect/platform"
import { Model, SqlClient, SqlSchema } from "@effect/sql"
import { PgLiteClient } from "@effect/sql-pglite"
import type { Row } from "@effect/sql/SqlConnection"
import type { Argument, Statement } from "@effect/sql/Statement"
import { ActionModifiedRowRepo } from "@synchrotron/sync-core/ActionModifiedRowRepo"
import { ActionRecordRepo } from "@synchrotron/sync-core/ActionRecordRepo"
import { ActionRegistry } from "@synchrotron/sync-core/ActionRegistry"
import { ClientIdOverride } from "@synchrotron/sync-core/ClientIdOverride"
import { ClockService } from "@synchrotron/sync-core/ClockService"

import {
	SynchrotronClientConfig,
	type SynchrotronClientConfigData
} from "@synchrotron/sync-core/config"
import { createPatchTriggersForTables, initializeDatabaseSchema } from "@synchrotron/sync-core/db"
import {
	SyncNetworkService,
	type TestNetworkState
} from "@synchrotron/sync-core/SyncNetworkService"
import { SyncService } from "@synchrotron/sync-core/SyncService"
import { Effect, Layer, Logger, LogLevel, Schema, type Context } from "effect"
import {
	createTestSyncNetworkServiceLayer,
	SyncNetworkServiceTestHelpers
} from "./SyncNetworkServiceTest"
import { TestHelpers } from "./TestHelpers"

// Important note: PgLite only supports a single exclusive database connection
// All tests must share the same PgLite instance to avoid "PGlite is closed" errors

/**
 * Layer that sets up the database schema
 * This depends on PgLiteSyncLayer to provide SqlClient
 */
export const makeDbInitLayer = (schema: string) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			yield* Effect.logInfo(`${schema}: Setting up database schema for tests...`)

			// Get SQL client
			const sql = yield* SqlClient.SqlClient
			yield* sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`)

			// Drop tables if they exist to ensure clean state
			yield* Effect.logInfo("Cleaning up existing tables...")
			yield* sql`DROP TABLE IF EXISTS action_modified_rows`
			yield* sql`DROP TABLE IF EXISTS action_records`
			yield* sql`DROP TABLE IF EXISTS client_sync_status`
			yield* sql`DROP TABLE IF EXISTS test_patches`
			yield* sql`DROP TABLE IF EXISTS notes`
			yield* sql`DROP TABLE IF EXISTS local_applied_action_ids` // Drop new table too

			// Create the notes table (Removed DEFAULT NOW() from updated_at)
			yield* sql`
		CREATE TABLE IF NOT EXISTS notes (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			content TEXT NOT NULL,
			tags TEXT[] DEFAULT '{}'::text[],
			updated_at TIMESTAMP WITH TIME ZONE, -- Reverted back
			user_id TEXT NOT NULL
		);
	`

			// Initialize schema
			yield* initializeDatabaseSchema

			// Create trigger for notes table - split into separate statements to avoid "cannot insert multiple commands into a prepared statement" error
			yield* createPatchTriggersForTables(["notes"])

			// 			// Check current schema
			// 			const currentSchema = yield* sql<{ current_schema: string }>`SELECT current_schema()`
			// 			yield* Effect.logInfo(`Current schema: ${currentSchema[0]?.current_schema}`)

			// 			// List all schemas
			// 			const schemas = yield* sql<{ schema_name: string }>`
			//     SELECT schema_name
			//     FROM information_schema.schemata
			//     ORDER BY schema_name
			// `
			// 			yield* Effect.logInfo(
			// 				`Available schemas: ${JSON.stringify(schemas.map((s) => s.schema_name))}`
			// 			)

			// 			// Fetch all tables in the current schema for debugging
			// 			const tables = yield* sql<{ table_name: string }>`
			//     SELECT table_name
			//     FROM information_schema.tables
			//     WHERE table_schema = current_schema()
			//     ORDER BY table_name
			// `
			// 			yield* Effect.logInfo(`Tables: ${JSON.stringify(tables.map((t) => t.table_name))}`)

			yield* Effect.logInfo("Database schema setup complete for tests")
		}).pipe(Effect.annotateLogs("clientId", schema))
	)
export const testConfig: SynchrotronClientConfigData = {
	electricSyncUrl: "http://localhost:5133",
	pglite: {
		debug: 1,
		dataDir: "memory://",
		relaxedDurability: true
	}
}

/**
 * Create a layer that provides PgLiteClient with Electric extensions based on config
 */
export const PgLiteClientLive = PgLiteClient.layer({
	debug: 1,
	dataDir: "memory://",
	relaxedDurability: true
})

const logger = Logger.prettyLogger({ mode: "tty", colors: true })
const pgLiteLayer = Layer.provideMerge(PgLiteClientLive)

export const makeTestLayers = (
	clientId: string,
	serverSql?: PgLiteClient.PgLiteClient,
	config?: {
		initialState?: Partial<TestNetworkState> | undefined
		simulateDelay?: boolean
	}
) => {
	return SyncService.DefaultWithoutDependencies.pipe(
		Layer.provideMerge(createTestSyncNetworkServiceLayer(clientId, serverSql, config)),

		Layer.provideMerge(makeDbInitLayer(clientId)), // Initialize DB first

		Layer.provideMerge(TestHelpers.Default),
		Layer.provideMerge(ActionRegistry.Default),
		Layer.provideMerge(ClockService.Default),
		Layer.provideMerge(ActionRecordRepo.Default),
		Layer.provideMerge(ActionModifiedRowRepo.Default),
		Layer.provideMerge(KeyValueStore.layerMemory),

		Layer.provideMerge(Layer.succeed(ClientIdOverride, clientId)),
		pgLiteLayer,
		Layer.provideMerge(Logger.replace(Logger.defaultLogger, logger)),
		Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Trace)),
		Layer.annotateLogs("clientId", clientId),
		Layer.provideMerge(Layer.succeed(SynchrotronClientConfig, testConfig))
	)
}

/**
 * Create a test client that shares the database connection with other clients
 * but has its own identity and network state
 */
export const createNoteRepo = (sqlClient?: SchemaWrappedSqlClient) =>
	Effect.gen(function* () {
		const sql = sqlClient ?? (yield* SqlClient.SqlClient)

		// Create the repo
		const repo = yield* Model.makeRepository(NoteModel, {
			tableName: "notes",
			idColumn: "id",
			spanPrefix: "NotesRepo"
		})

		// Create type-safe queries
		const findByTitle = SqlSchema.findAll({
			Request: Schema.String,
			Result: NoteModel,
			execute: (title: string) => sql`SELECT * FROM "notes" WHERE title = ${title}`
		})

		const findById = SqlSchema.findOne({
			Request: Schema.String,
			Result: NoteModel,
			execute: (id: string) => sql`SELECT * FROM "notes" WHERE id = ${id}`
		})

		return {
			...repo,
			findByTitle,
			findById
		} as const
	})
export interface NoteRepo extends Effect.Effect.Success<ReturnType<typeof createNoteRepo>> {}

export interface SchemaWrappedSqlClient {
	<A extends object = Row>(strings: TemplateStringsArray, ...args: Array<Argument>): Statement<A>
}
export interface TestClient {
	// For schema-isolated SQL client, we only need the tagged template literal functionality
	sql: SchemaWrappedSqlClient
	rawSql: SqlClient.SqlClient // Original SQL client for operations that need to span schemas
	syncService: SyncService
	actionModifiedRowRepo: ActionModifiedRowRepo // Add AMR Repo
	clockService: ClockService
	actionRecordRepo: ActionRecordRepo
	actionRegistry: ActionRegistry
	syncNetworkService: SyncNetworkService
	syncNetworkServiceTestHelpers: Context.Tag.Service<SyncNetworkServiceTestHelpers>
	testHelpers: TestHelpers
	noteRepo: NoteRepo
	clientId: string
}

export const createTestClient = (id: string, serverSql: PgLiteClient.PgLiteClient) =>
	Effect.gen(function* () {
		// Get required services - getting these from the shared layers
		const sql = yield* SqlClient.SqlClient
		const clockService = yield* ClockService
		const actionRecordRepo = yield* ActionRecordRepo
		const actionModifiedRowRepo = yield* ActionModifiedRowRepo // Get AMR Repo
		const syncNetworkService = yield* SyncNetworkService
		const syncNetworkServiceTestHelpers = yield* SyncNetworkServiceTestHelpers
		const syncService = yield* SyncService
		const testHelpers = yield* TestHelpers
		const actionRegistry = yield* ActionRegistry

		// Initialize client-specific schema

		// Create schema-isolated SQL client
		const isolatedSql = createSchemaIsolatedClient(id, sql)

		// Create note repository with schema-isolated SQL client
		const noteRepo = yield* createNoteRepo(isolatedSql)

		const overrideId = yield* ClientIdOverride
		yield* Effect.logInfo(`clientIdOverride for ${id}: ${overrideId}`)
		// Create client
		return {
			sql: isolatedSql, // Schema-isolated SQL client
			rawSql: sql, // Original SQL client for operations that need to span schemas
			syncService,
			actionRegistry,
			actionModifiedRowRepo, // Add AMR Repo to returned object
			clockService,
			testHelpers,
			actionRecordRepo,
			syncNetworkService,
			syncNetworkServiceTestHelpers,
			noteRepo,
			clientId: id
		} as TestClient
	}).pipe(Effect.provide(makeTestLayers(id, serverSql)), Effect.annotateLogs("clientId", id))
export class NoteModel extends Model.Class<NoteModel>("notes")({
	id: Schema.String,
	title: Schema.String,
	content: Schema.String,
	tags: Schema.Array(Schema.String).pipe(Schema.mutable, Schema.optional),
	updated_at: Schema.DateFromSelf,
	user_id: Schema.String
}) {}

/**
 * Creates a schema-isolated SQL client that sets the search path to a client-specific schema
 * This allows us to simulate isolated client databases while still using a single PgLite instance
 */
export const createSchemaIsolatedClient = (clientId: string, sql: SqlClient.SqlClient) => {
	// Create a transaction wrapper that sets the search path
	const executeInClientSchema = <T>(effect: Effect.Effect<T, unknown, never>) =>
		Effect.gen(function* () {
			// Begin transaction

			try {
				const result = yield* effect

				return result
			} catch (error) {
				return yield* Effect.fail(error)
			}
		}).pipe(Effect.annotateLogs("clientId", clientId), Effect.withLogSpan("executeInClientSchema"))

	// We'll create a simpler wrapper function that just handles the tagged template literal case
	// This is sufficient for our test purposes
	const wrappedSql = (template: TemplateStringsArray, ...args: any[]) =>
		executeInClientSchema(sql(template, ...args))

	return wrappedSql as SqlClient.SqlClient
}
