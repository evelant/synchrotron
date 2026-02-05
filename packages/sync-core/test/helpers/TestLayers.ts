import { KeyValueStore } from "@effect/platform"
import { Model, SqlClient, SqlSchema } from "@effect/sql"
import { PgliteClient } from "@effect/sql-pglite"
import type { Row } from "@effect/sql/SqlConnection"
import type { Statement } from "@effect/sql/Statement"
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp"
import { ActionModifiedRowRepo } from "@synchrotron/sync-core/ActionModifiedRowRepo"
import { ActionRecordRepo } from "@synchrotron/sync-core/ActionRecordRepo"
import { ActionRegistry } from "@synchrotron/sync-core/ActionRegistry"
import { ClientClockState } from "@synchrotron/sync-core/ClientClockState"
import {
	ClientDbAdapter,
	type ClientDbAdapterService
} from "@synchrotron/sync-core/ClientDbAdapter"
import { ClientIdOverride } from "@synchrotron/sync-core/ClientIdOverride"
import { PostgresClientDbAdapter } from "@synchrotron/sync-core/PostgresClientDbAdapter"
import {
	DeterministicId,
	DeterministicIdIdentityConfig,
	type DeterministicIdIdentityStrategy
} from "@synchrotron/sync-core/DeterministicId"

import {
	applySyncTriggers,
	initializeClientDatabaseSchema,
	initializeDatabaseSchema
} from "@synchrotron/sync-core/db" // Import applySyncTriggers
import { SyncNetworkService } from "@synchrotron/sync-core/SyncNetworkService"
import { SyncService } from "@synchrotron/sync-core/SyncService"
import { Effect, Layer, Logger, LogLevel, Schema } from "effect"
import {
	createTestSyncNetworkServiceLayer,
	SyncNetworkServiceTestHelpers,
	type SyncNetworkServiceTestHelpersService,
	type TestNetworkState
} from "./SyncNetworkServiceTest"
import { ClientIdentityTestLive } from "./ClientIdentityTestLive"
import { TestHelpers } from "./TestHelpers"

// Important note: PgLite only supports a single exclusive database connection
// All clients within a single test must share the same PgLite instance.

/**
 * Initialize the database schema for tests.
 *
 * This depends on `SqlClient` being available in the environment.
 */
const initializeDbForTests = (schema: string) =>
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
		yield* sql`DROP TABLE IF EXISTS sync_server_meta`
		yield* sql`DROP TABLE IF EXISTS test_patches`
		yield* sql`DROP TABLE IF EXISTS notes`
		yield* sql`DROP TABLE IF EXISTS local_applied_action_ids` // Drop new table too
		yield* sql`DROP TABLE IF EXISTS local_quarantined_actions`

		// Create the notes table (Removed DEFAULT NOW() from updated_at)
		yield* sql`
		CREATE TABLE IF NOT EXISTS notes (
			id TEXT PRIMARY KEY, -- Removed DEFAULT gen_random_uuid() or similar
			title TEXT NOT NULL,
			content TEXT NOT NULL,
			tags TEXT[] DEFAULT '{}'::text[],
			updated_at TIMESTAMP WITH TIME ZONE, -- Reverted back
			user_id TEXT NOT NULL,
			audience_key TEXT GENERATED ALWAYS AS ('user:' || user_id) STORED
		);
	`

		// Initialize schema
		yield* schema === "server" ? initializeDatabaseSchema : initializeClientDatabaseSchema

		// Apply sync patch-capture triggers to the notes table
		yield* applySyncTriggers(["notes"])

		yield* Effect.logInfo("Database schema setup complete for tests")
	}).pipe(Effect.annotateLogs("clientId", schema))

/**
 * Create a layer that provides PgliteClient with Electric extensions based on config
 */
const PgliteClientLive = PgliteClient.layer({
	// debug: 1,
	dataDir: "memory://",
	relaxedDurability: true,
	extensions: {
		uuid_ossp
	}
}).pipe(Layer.fresh)

const logger = Logger.prettyLogger({ mode: "tty", colors: true })
const testLogLevel = (() => {
	const raw = process.env.SYNC_TEST_LOG_LEVEL?.toLowerCase()
	switch (raw) {
		case "trace":
			return LogLevel.Trace
		case "debug":
			return LogLevel.Debug
		case "info":
			return LogLevel.Info
		case "warning":
		case "warn":
			return LogLevel.Warning
		case "error":
			return LogLevel.Error
		case "fatal":
			return LogLevel.Fatal
		default:
			return LogLevel.Info
	}
})()

export const makeTestLayers = (
	clientId: string,
	serverSql?: PgliteClient.PgliteClient,
	config?: {
		initialState?: Partial<TestNetworkState> | undefined
		simulateDelay?: boolean
		identityByTable?: Readonly<Record<string, DeterministicIdIdentityStrategy>> | undefined
	}
) => {
	const identityByTable = config?.identityByTable ?? {
		notes: (row: any) => row,
		test_apply_patches: (row: any) => row
	}

	const baseLayer = Layer.mergeAll(
		PgliteClientLive,
		KeyValueStore.layerMemory,
		Layer.succeed(ClientIdOverride, clientId),
		Layer.succeed(DeterministicIdIdentityConfig, {
			identityByTable
		}),
		Logger.replace(Logger.defaultLogger, logger),
		Logger.minimumLogLevel(testLogLevel)
	)

	const baseWithDbInit = baseLayer.pipe(
		Layer.tap((context) => initializeDbForTests(clientId).pipe(Effect.provide(context)))
	)

	const layer = SyncService.DefaultWithoutDependencies.pipe(
		Layer.provideMerge(TestHelpers.Default),
		Layer.provideMerge(createTestSyncNetworkServiceLayer(clientId, serverSql, config)),
		Layer.provideMerge(ClientClockState.Default),
		Layer.provideMerge(ActionModifiedRowRepo.Default),
		Layer.provideMerge(ActionRecordRepo.Default),
		Layer.provideMerge(DeterministicId.Default),
		Layer.provideMerge(ActionRegistry.Default),
		Layer.provideMerge(PostgresClientDbAdapter),
		Layer.provideMerge(ClientIdentityTestLive),
		Layer.provideMerge(baseWithDbInit)
	)

	return Layer.annotateLogs(layer, "clientId", clientId)
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
interface NoteRepo extends Effect.Effect.Success<ReturnType<typeof createNoteRepo>> {}

interface SchemaWrappedSqlClient {
	<A extends object = Row>(strings: TemplateStringsArray, ...args: Array<unknown>): Statement<A>
}
interface TestClient {
	// For schema-isolated SQL client, we only need the tagged template literal functionality
	sql: SchemaWrappedSqlClient
	rawSql: SqlClient.SqlClient // Original SQL client for operations that need to span schemas
	syncService: SyncService
	actionModifiedRowRepo: ActionModifiedRowRepo // Add AMR Repo
	clockState: ClientClockState
	actionRecordRepo: ActionRecordRepo
	actionRegistry: ActionRegistry
	deterministicId: DeterministicId
	clientDbAdapter: ClientDbAdapterService
	syncNetworkService: SyncNetworkService
	syncNetworkServiceTestHelpers: SyncNetworkServiceTestHelpersService
	testHelpers: TestHelpers
	noteRepo: NoteRepo
	clientId: string
}

export const createTestClient = (
	id: string,
	serverSql: PgliteClient.PgliteClient,
	config?: {
		initialState?: Partial<TestNetworkState> | undefined
		simulateDelay?: boolean
		identityByTable?: Readonly<Record<string, DeterministicIdIdentityStrategy>> | undefined
	}
) =>
	Effect.gen(function* () {
		// Get required services - getting these from the shared layers
		const sql = yield* SqlClient.SqlClient
		const clockState = yield* ClientClockState
		const actionRecordRepo = yield* ActionRecordRepo
		const actionModifiedRowRepo = yield* ActionModifiedRowRepo // Get AMR Repo
		const clientDbAdapter = yield* ClientDbAdapter
		const syncNetworkService = yield* SyncNetworkService
		const syncNetworkServiceTestHelpers = yield* SyncNetworkServiceTestHelpers
		const syncService = yield* SyncService
		const testHelpers = yield* TestHelpers
		const actionRegistry = yield* ActionRegistry
		const deterministicId = yield* DeterministicId

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
			clockState,
			testHelpers,
			actionRecordRepo,
			clientDbAdapter,
			deterministicId,
			syncNetworkService,
			syncNetworkServiceTestHelpers,
			noteRepo,
			clientId: id
		} as TestClient
	}).pipe(
		Effect.provide(makeTestLayers(id, serverSql, config)),
		Effect.annotateLogs("clientId", id)
	)
export class NoteModel extends Model.Class<NoteModel>("notes")({
	id: Schema.UUID,
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
const createSchemaIsolatedClient = (clientId: string, sql: SqlClient.SqlClient) => {
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
