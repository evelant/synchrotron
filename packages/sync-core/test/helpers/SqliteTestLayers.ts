import { KeyValueStore } from "@effect/platform"
import { Model, SqlClient } from "@effect/sql"
import * as SqlStatement from "@effect/sql/Statement"
import { PgliteClient } from "@effect/sql-pglite"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp"
import {
	ActionModifiedRowRepo,
	ActionRecordRepo,
	ActionRegistry,
	ClientClockState,
	ClientDbAdapter,
	ClientIdentity,
	ClientIdOverride,
	DeterministicId,
	DeterministicIdIdentityConfig,
	type DeterministicIdIdentityStrategy,
	SqliteClientDbAdapter,
	SyncNetworkService,
	SyncService
} from "@synchrotron/sync-core"
import { initializeDatabaseSchema } from "@synchrotron/sync-core/db"
import type { ClientDbAdapterService } from "@synchrotron/sync-core/ClientDbAdapter"
import type { Scope } from "effect"
import { Effect, Layer, Option, Schema } from "effect"
import {
	createTestSyncNetworkServiceLayer,
	SyncNetworkServiceTestHelpers,
	type SyncNetworkServiceTestHelpersService
} from "./SyncNetworkServiceTest"
import { ClientIdentityTestLive } from "./ClientIdentityTestLive"

const JsonColumn = <S extends Schema.Schema.Any>(schema: S) =>
	Model.Field({
		select: Schema.Union(schema, Schema.parseJson(schema)),
		insert: Schema.parseJson(schema),
		update: Schema.parseJson(schema),
		json: schema,
		jsonCreate: schema,
		jsonUpdate: schema
	})

const DbDateTime = Model.Field({
	select: Schema.Union(Schema.DateFromString, Schema.DateFromSelf),
	insert: Schema.DateFromString,
	update: Schema.DateFromString,
	json: Schema.DateFromString,
	jsonCreate: Schema.DateFromString,
	jsonUpdate: Schema.DateFromString
})

class NoteModelPortable extends Model.Class<NoteModelPortable>("notes")({
	id: Schema.UUID,
	title: Schema.String,
	content: Schema.String,
	tags: JsonColumn(Schema.Array(Schema.String)),
	updated_at: DbDateTime,
	user_id: Schema.String
}) {}

const createNoteRepoPortable = () =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient

		return yield* Model.makeRepository(NoteModelPortable, {
			tableName: "notes",
			idColumn: "id",
			spanPrefix: "NotesRepoPortable"
		}).pipe(Effect.provideService(SqlClient.SqlClient, sql))
	})

interface NoteRepoPortable extends Effect.Effect.Success<
	ReturnType<typeof createNoteRepoPortable>
> {}

class SqliteTestHelpers extends Effect.Service<SqliteTestHelpers>()("SqliteTestHelpers", {
	effect: Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		const actionRegistry = yield* ActionRegistry
		const identity = yield* ClientIdentity
		const deterministicId = yield* DeterministicId

		const noteRepo = yield* createNoteRepoPortable()

		const createNoteAction = actionRegistry.defineAction(
			"test-create-note",
			Schema.Struct({
				title: Schema.String,
				content: Schema.String,
				user_id: Schema.String,
				tags: Schema.optional(Schema.Array(Schema.String)),
				timestamp: Schema.Number
			}),
			(args) =>
				Effect.gen(function* () {
					const row = {
						title: args.title,
						content: args.content,
						user_id: args.user_id,
						updated_at: new Date(args.timestamp),
						tags: args.tags ? Array.from(args.tags) : []
					}

					const id = yield* deterministicId.forRow("notes", row)
					return yield* noteRepo.insert({ id, ...row })
				})
		)

		const updateTagsAction = actionRegistry.defineAction(
			"test-update-tags",
			Schema.Struct({
				id: Schema.String,
				tags: Schema.Array(Schema.String),
				timestamp: Schema.Number
			}),
			(args) =>
				Effect.gen(function* () {
					const note = yield* noteRepo.findById(args.id)
					if (Option.isSome(note)) {
						yield* noteRepo.updateVoid({
							...note.value,
							tags: Array.from(args.tags),
							updated_at: new Date(args.timestamp)
						})
					}
				})
		)

		const updateContentAction = actionRegistry.defineAction(
			"test-update-content",
			Schema.Struct({ id: Schema.String, content: Schema.String, timestamp: Schema.Number }),
			(args) =>
				Effect.gen(function* () {
					const note = yield* noteRepo.findById(args.id)
					if (Option.isSome(note)) {
						yield* noteRepo.updateVoid({
							...note.value,
							content: args.content,
							updated_at: new Date(args.timestamp)
						})
					}
				})
		)

		const updateTitleAction = actionRegistry.defineAction(
			"test-update-title",
			Schema.Struct({ id: Schema.String, title: Schema.String, timestamp: Schema.Number }),
			(args) =>
				Effect.gen(function* () {
					const note = yield* noteRepo.findById(args.id)
					if (Option.isSome(note)) {
						yield* noteRepo.updateVoid({
							...note.value,
							title: args.title,
							updated_at: new Date(args.timestamp)
						})
					}
				})
		)

		const conditionalUpdateAction = actionRegistry.defineAction(
			"test-conditional-update",
			Schema.Struct({
				id: Schema.String,
				baseContent: Schema.String,
				conditionalSuffix: Schema.optional(Schema.String),
				timestamp: Schema.Number
			}),
			(args) =>
				Effect.gen(function* () {
					const clientId = yield* identity.get
					const noteOpt = yield* noteRepo.findById(args.id)
					if (Option.isSome(noteOpt)) {
						const note = noteOpt.value
						const newContent =
							clientId === "clientA"
								? args.baseContent + (args.conditionalSuffix ?? "")
								: args.baseContent

						yield* noteRepo.updateVoid({
							...note,
							content: newContent,
							updated_at: new Date(args.timestamp)
						})
					}
				})
		)

		const conditionalUpdateWithClientCExtraAction = actionRegistry.defineAction(
			"test-conditional-update-clientc-extra",
			Schema.Struct({
				id: Schema.String,
				baseContent: Schema.String,
				conditionalSuffix: Schema.optional(Schema.String),
				clientCTags: Schema.Array(Schema.String),
				timestamp: Schema.Number
			}),
			(args) =>
				Effect.gen(function* () {
					const clientId = yield* identity.get
					const noteOpt = yield* noteRepo.findById(args.id)
					if (Option.isSome(noteOpt)) {
						const note = noteOpt.value
						const newContent =
							clientId === "clientA"
								? args.baseContent + (args.conditionalSuffix ?? "")
								: args.baseContent
						const nextTags = clientId === "clientC" ? Array.from(args.clientCTags) : note.tags

						yield* noteRepo.updateVoid({
							...note,
							content: newContent,
							tags: nextTags,
							updated_at: new Date(args.timestamp)
						})
					}
				})
		)

		const createNoteClientSpecificInsertAction = actionRegistry.defineAction(
			"test-create-note-client-specific-insert",
			Schema.Struct({
				title: Schema.String,
				baseContent: Schema.String,
				user_id: Schema.String,
				timestamp: Schema.Number
			}),
			(args) =>
				Effect.gen(function* () {
					const clientId = yield* identity.get
					const row = {
						title: args.title,
						content: `${args.baseContent}-${clientId}`,
						user_id: args.user_id,
						updated_at: new Date(args.timestamp),
						tags: []
					}

					const id = yield* deterministicId.forRow("notes", row)
					return yield* noteRepo.insert({ id, ...row })
				})
		)

		const createNoteWithExtraRowOnClientBAction = actionRegistry.defineAction(
			"test-create-note-with-extra-row-on-clientb",
			Schema.Struct({
				title: Schema.String,
				content: Schema.String,
				user_id: Schema.String,
				timestamp: Schema.Number
			}),
			(args) =>
				Effect.gen(function* () {
					const noteRow = {
						title: args.title,
						content: args.content,
						user_id: args.user_id,
						updated_at: new Date(args.timestamp),
						tags: []
					}

					const noteId = yield* deterministicId.forRow("notes", noteRow)
					yield* noteRepo.insert({ id: noteId, ...noteRow })

					const clientId = yield* identity.get
					if (clientId !== "clientB") return { noteId } as const

					const metaRow = {
						note_id: noteId,
						kind: "extra",
						user_id: args.user_id
					}
					const metaId = yield* deterministicId.forRow("note_admin_meta", metaRow)

					yield* sql`
						INSERT INTO note_admin_meta (id, note_id, kind, user_id)
						VALUES (${metaId}, ${noteId}, ${metaRow.kind}, ${metaRow.user_id})
					`

					return { noteId, metaId } as const
				})
		)

		const createNoteWithExtraRowOnClientAAction = actionRegistry.defineAction(
			"test-create-note-with-extra-row-on-clienta",
			Schema.Struct({
				title: Schema.String,
				content: Schema.String,
				user_id: Schema.String,
				timestamp: Schema.Number
			}),
			(args) =>
				Effect.gen(function* () {
					const noteRow = {
						title: args.title,
						content: args.content,
						user_id: args.user_id,
						updated_at: new Date(args.timestamp),
						tags: []
					}

					const noteId = yield* deterministicId.forRow("notes", noteRow)
					yield* noteRepo.insert({ id: noteId, ...noteRow })

					const clientId = yield* identity.get
					if (clientId !== "clientA") return { noteId } as const

					const metaRow = {
						note_id: noteId,
						kind: "origin-only",
						user_id: args.user_id
					}
					const metaId = yield* deterministicId.forRow("note_admin_meta", metaRow)

					yield* sql`
							INSERT INTO note_admin_meta (id, note_id, kind, user_id)
							VALUES (${metaId}, ${noteId}, ${metaRow.kind}, ${metaRow.user_id})
						`

					return { noteId, metaId } as const
				})
		)

		const clientSpecificContentAction = actionRegistry.defineAction(
			"test-client-specific-content",
			Schema.Struct({
				id: Schema.String,
				baseContent: Schema.String,
				timestamp: Schema.Number
			}),
			(args) =>
				Effect.gen(function* () {
					const clientId = yield* identity.get
					const noteOpt = yield* noteRepo.findById(args.id)
					if (Option.isSome(noteOpt)) {
						const note = noteOpt.value
						yield* noteRepo.updateVoid({
							...note,
							content: `${args.baseContent}-${clientId}`,
							updated_at: new Date(args.timestamp)
						})
					}
				})
		)

		const deleteContentAction = actionRegistry.defineAction(
			"test-delete-content",
			Schema.Struct({ id: Schema.String, user_id: Schema.String, timestamp: Schema.Number }),
			(args) =>
				Effect.gen(function* () {
					yield* noteRepo.delete(args.id)
				})
		)

		return {
			createNoteAction,
			updateTagsAction,
			updateContentAction,
			updateTitleAction,
			conditionalUpdateAction,
			conditionalUpdateWithClientCExtraAction,
			createNoteClientSpecificInsertAction,
			createNoteWithExtraRowOnClientBAction,
			createNoteWithExtraRowOnClientAAction,
			clientSpecificContentAction,
			deleteContentAction,
			noteRepo
		}
	})
}) {}

type SqliteTestLayerConfig = {
	readonly identityByTable?: Readonly<Record<string, DeterministicIdIdentityStrategy>> | undefined
}

const makeSqliteTestLayers = (
	clientId: string,
	serverSql: PgliteClient.PgliteClient,
	config?: SqliteTestLayerConfig
) => {
	const identityByTable = config?.identityByTable ?? {
		notes: (row: any) => row,
		test_apply_patches: (row: any) => row
	}

	const baseLayer = Layer.mergeAll(
		SqliteClient.layer({ filename: ":memory:" }),
		KeyValueStore.layerMemory,
		Layer.succeed(ClientIdOverride, clientId),
		Layer.succeed(DeterministicIdIdentityConfig, {
			identityByTable
		})
	)

	const baseWithDebug =
		process.env.SYNC_SQL_DEBUG === "1"
			? Layer.mergeAll(
					baseLayer,
					SqlStatement.setTransformer((statement) =>
						Effect.sync(() => {
							const [sql, params] = statement.compile()
							console.log("[sqlite sql]", sql, params)
							return statement
						})
					)
				)
			: baseLayer

	const layer0 = SqliteClientDbAdapter.pipe(Layer.provideMerge(baseWithDebug))

	const layer1 = ActionRegistry.Default.pipe(Layer.provideMerge(layer0))
	const layer2 = DeterministicId.Default.pipe(Layer.provideMerge(layer1))
	const layer3 = ActionRecordRepo.Default.pipe(Layer.provideMerge(layer2))
	const layer4 = ActionModifiedRowRepo.Default.pipe(Layer.provideMerge(layer3))

	const layer5 = Layer.effectDiscard(
		Effect.gen(function* () {
			const sqlClient = yield* SqlClient.SqlClient
			const clientDbAdapter = yield* ClientDbAdapter

			yield* clientDbAdapter.initializeSyncSchema

			yield* sqlClient`
				CREATE TABLE notes (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					content TEXT NOT NULL,
					tags TEXT NOT NULL DEFAULT '[]',
					updated_at TEXT NOT NULL,
					user_id TEXT NOT NULL,
					audience_key TEXT GENERATED ALWAYS AS ('user:' || user_id) STORED
				)
			`.raw

			yield* clientDbAdapter.installPatchCapture(["notes"])
		})
	).pipe(Layer.provideMerge(layer4))

	const layer6 = ClientIdentityTestLive.pipe(Layer.provideMerge(layer5))
	const layer7 = ClientClockState.Default.pipe(Layer.provideMerge(layer6))
	const layer8 = createTestSyncNetworkServiceLayer(clientId, serverSql).pipe(
		Layer.provideMerge(layer7)
	)
	const layer9 = SqliteTestHelpers.Default.pipe(Layer.provideMerge(layer8))

	return SyncService.DefaultWithoutDependencies.pipe(Layer.provideMerge(layer9))
}

interface SqliteTestClient {
	sql: SqlClient.SqlClient
	syncService: SyncService
	actionRecordRepo: ActionRecordRepo
	actionModifiedRowRepo: ActionModifiedRowRepo
	deterministicId: DeterministicId
	clientDbAdapter: ClientDbAdapterService
	clockState: ClientClockState
	actionRegistry: ActionRegistry
	syncNetworkService: SyncNetworkService
	syncNetworkServiceTestHelpers: SyncNetworkServiceTestHelpersService
	testHelpers: SqliteTestHelpers
	noteRepo: NoteRepoPortable
	clientId: string
}

export const withSqliteTestClient = <A, E, R = never>(
	clientId: string,
	serverSql: PgliteClient.PgliteClient,
	config: SqliteTestLayerConfig | undefined,
	f: (client: SqliteTestClient) => Effect.Effect<A, E, R>
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		const clockState = yield* ClientClockState
		const actionRecordRepo = yield* ActionRecordRepo
		const actionModifiedRowRepo = yield* ActionModifiedRowRepo
		const clientDbAdapter = yield* ClientDbAdapter
		const syncNetworkService = yield* SyncNetworkService
		const syncNetworkServiceTestHelpers = yield* SyncNetworkServiceTestHelpers
		const syncService = yield* SyncService
		const testHelpers = yield* SqliteTestHelpers
		const actionRegistry = yield* ActionRegistry
		const deterministicId = yield* DeterministicId
		const noteRepo = testHelpers.noteRepo

		const client = {
			sql,
			syncService,
			actionRecordRepo,
			actionModifiedRowRepo,
			deterministicId,
			clientDbAdapter,
			clockState,
			actionRegistry,
			syncNetworkService,
			syncNetworkServiceTestHelpers,
			testHelpers,
			noteRepo,
			clientId
		} as const satisfies SqliteTestClient

		return yield* f(client)
	}).pipe(
		Effect.provide(makeSqliteTestLayers(clientId, serverSql, config)),
		Effect.annotateLogs("clientId", clientId)
	)

export const withSqliteTestClients = <A, E, R = never>(
	clientIds: ReadonlyArray<string>,
	serverSql: PgliteClient.PgliteClient,
	config: SqliteTestLayerConfig | undefined,
	f: (clients: ReadonlyArray<SqliteTestClient>) => Effect.Effect<A, E, R>
): Effect.Effect<A, unknown, Scope.Scope | R> => {
	const loop = (
		remainingIds: ReadonlyArray<string>,
		acc: ReadonlyArray<SqliteTestClient>
	): Effect.Effect<A, unknown, Scope.Scope | R> => {
		if (remainingIds.length === 0) {
			return f(acc)
		}

		const [head, ...tail] = remainingIds
		if (!head) {
			return f(acc)
		}

		return withSqliteTestClient(head, serverSql, config, (client) => loop(tail, [...acc, client]))
	}

	return loop(clientIds, [])
}

export const makeSqliteTestServerLayer = (
	dataDir: string = `memory://sqlite-semantics-server-${crypto.randomUUID()}`
) => {
	const baseLayer = PgliteClient.layer({
		dataDir,
		relaxedDurability: true,
		extensions: {
			uuid_ossp
		}
	})

	return Layer.effectDiscard(
		Effect.gen(function* () {
			const sqlClient = yield* SqlClient.SqlClient

			yield* initializeDatabaseSchema

			yield* sqlClient`
				CREATE TABLE notes (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					content TEXT NOT NULL,
					tags TEXT NOT NULL DEFAULT '[]',
					updated_at TEXT NOT NULL,
					user_id TEXT NOT NULL,
					audience_key TEXT GENERATED ALWAYS AS ('user:' || user_id) STORED
				)
			`.raw
		})
	).pipe(Layer.provideMerge(baseLayer))
}
