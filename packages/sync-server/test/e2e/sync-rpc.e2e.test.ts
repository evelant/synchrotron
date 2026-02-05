import { KeyValueStore } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { describe, expect, it } from "@effect/vitest"
import { makeSynchrotronClientLayer } from "@synchrotron/sync-client"
import { ActionModifiedRowRepo } from "@synchrotron/sync-core/ActionModifiedRowRepo"
import { ActionRegistry } from "@synchrotron/sync-core/ActionRegistry"
import { ActionRecordRepo } from "@synchrotron/sync-core/ActionRecordRepo"
import { ClientDbAdapter } from "@synchrotron/sync-core/ClientDbAdapter"
import { ClientIdentity } from "@synchrotron/sync-core"
import { ClientIdOverride } from "@synchrotron/sync-core/ClientIdOverride"
import {
	SendLocalActionsBehindHead,
	SyncNetworkService
} from "@synchrotron/sync-core/SyncNetworkService"
import { SyncService } from "@synchrotron/sync-core/SyncService"
import { ConfigProvider, Effect, Layer, Runtime, Schema } from "effect"
import { SignJWT } from "jose"
import { makeInProcessSyncRpcServer, TestSyncRpcBaseUrl } from "./harness"

const waitForNextMillisecond = Effect.sync(() => {
	const start = Date.now()
	while (Date.now() <= start) {
		// busy-wait: HLC uses Date.now(), not Effect TestClock
	}
})

const signHs256Jwt = (params: {
	readonly secret: string
	readonly sub: string
	readonly aud?: string
}) =>
	new SignJWT({ role: "authenticated" })
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(params.sub)
		.setAudience(params.aud ?? "authenticated")
		.setIssuedAt()
		.setExpirationTime("2h")
		.sign(new TextEncoder().encode(params.secret))

const getNoteContent = (noteId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		const rows = yield* sql<{ readonly content: string }>`
			SELECT content
			FROM notes
			WHERE id = ${noteId}
		`
		return rows[0]?.content ?? null
	})

const getNoteCount = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const rows = yield* sql<{ readonly count: number | string }>`
		SELECT count(*)::int as count
		FROM notes
	`
	return typeof rows[0]?.count === "number" ? rows[0].count : Number(rows[0]?.count ?? 0)
})

const setupClientNotes = Effect.gen(function* () {
	const clientDb = yield* ClientDbAdapter
	const sql = yield* SqlClient.SqlClient

	yield* clientDb.initializeSyncSchema

	yield* sql`
		CREATE TABLE IF NOT EXISTS notes (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			project_id TEXT NOT NULL,
			audience_key TEXT GENERATED ALWAYS AS ('project:' || project_id) STORED
		);
	`

	yield* clientDb.installPatchCapture(["notes"])
})

const defineClientActions = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const actionRegistry = yield* ActionRegistry
	const identity = yield* ClientIdentity

	const createNoteWithId = actionRegistry.defineAction(
		"e2e-create-note-with-id",
		Schema.Struct({
			id: Schema.String,
			content: Schema.String,
			project_id: Schema.String,
			timestamp: Schema.Number
		}),
		(args) =>
			Effect.gen(function* () {
				yield* sql`
					INSERT INTO notes (id, content, project_id)
					VALUES (${args.id}, ${args.content}, ${args.project_id})
				`
			})
	)

	const clientSpecificContent = actionRegistry.defineAction(
		"e2e-client-specific-content",
		Schema.Struct({
			id: Schema.String,
			baseContent: Schema.String,
			timestamp: Schema.Number
		}),
		(args) =>
			Effect.gen(function* () {
				const clientId = yield* identity.get
				yield* sql`
					UPDATE notes
					SET content = ${`${args.baseContent}-${clientId}`}
					WHERE id = ${args.id}
				`
			})
	)

	const updateNoteContent = actionRegistry.defineAction(
		"e2e-update-note-content",
		Schema.Struct({
			id: Schema.String,
			content: Schema.String,
			timestamp: Schema.Number
		}),
		(args) =>
			Effect.gen(function* () {
				yield* sql`
					UPDATE notes
					SET content = ${args.content}
					WHERE id = ${args.id}
				`
			})
	)

	return { createNoteWithId, clientSpecificContent, updateNoteContent } as const
})

const withInProcessFetch = <A, E, R>(
	baseUrl: string,
	handler: (request: Request) => Promise<Response>,
	effect: Effect.Effect<A, E, R>
) =>
	Effect.acquireUseRelease(
		Effect.sync(() => {
			const originalFetch = globalThis.fetch
			const baseOrigin = new URL(baseUrl).origin

			const patchedFetch: typeof fetch = (input: any, init?: any) => {
				const request = input instanceof Request ? input : new Request(input, init)
				const url = new URL(request.url)
				if (url.origin === baseOrigin) {
					return handler(request)
				}
				return originalFetch(input, init)
			}

			;(globalThis as any).fetch = patchedFetch
			return originalFetch
		}),
		() => effect,
		(originalFetch) =>
			Effect.sync(() => {
				;(globalThis as any).fetch = originalFetch
			})
	)

const makeClientLayer = (params: {
	readonly clientId: string
	readonly syncRpcUrl: string
	readonly syncRpcAuthToken: string
	readonly pgliteDataDir: string
}) =>
	makeSynchrotronClientLayer({
		rowIdentityByTable: {
			notes: (row) => row
		},
		config: {
			syncRpcUrl: params.syncRpcUrl,
			syncRpcAuthToken: params.syncRpcAuthToken,
			electricSyncUrl: "http://unused",
			pglite: { dataDir: params.pgliteDataDir, debug: 0, relaxedDurability: true }
		},
		keyValueStoreLayer: KeyValueStore.layerMemory.pipe(Layer.fresh)
	}).pipe(
		Layer.provideMerge(Layer.succeed(ClientIdOverride, params.clientId)),
		Layer.provideMerge(Layer.scope)
	)

describe("E2E (HTTP RPC): SyncNetworkServiceLive + SyncNetworkRpcHandlersLive", () => {
	it.scoped(
		"bootstrap from empty client DB uses server snapshot (no action replay)",
		() =>
			Effect.gen(function* () {
				const secret = "supersecretvalue-supersecretvalue"
				const token = yield* Effect.promise(() =>
					signHs256Jwt({ secret, sub: "userA", aud: "authenticated" })
				)

				const server = yield* makeInProcessSyncRpcServer({
					dataDir: `memory://server-${crypto.randomUUID()}`,
					baseUrl: TestSyncRpcBaseUrl,
					configProvider: ConfigProvider.fromMap(
						new Map([
							["SYNC_JWT_SECRET", secret],
							["SYNC_JWT_AUD", "authenticated"]
						])
					)
				})

				const syncRpcUrl = `${server.baseUrl}/rpc`
				const runOnServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
					Effect.promise(() => Runtime.runPromise(server.runtime)(effect as any)) as Effect.Effect<
						A,
						E,
						never
					>
				const runOnServerAsUser =
					(userId: string) =>
					<A, E, R>(effect: Effect.Effect<A, E, R>) =>
						runOnServer(
							Effect.gen(function* () {
								const sql = yield* SqlClient.SqlClient
								return yield* Effect.gen(function* () {
									yield* sql`SELECT set_config('synchrotron.user_id', ${userId}, true)`
									yield* sql`SELECT set_config('request.jwt.claim.sub', ${userId}, true)`
									return yield* effect
								}).pipe(sql.withTransaction)
							})
						)

				const noteId = crypto.randomUUID()
				const projectId = `project-${crypto.randomUUID()}`

				yield* runOnServer(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient
						yield* sql`INSERT INTO projects (id) VALUES (${projectId}) ON CONFLICT DO NOTHING`
						yield* sql`
							INSERT INTO project_members (id, project_id, user_id)
							VALUES (${`${projectId}-userA`}, ${projectId}, 'userA')
							ON CONFLICT DO NOTHING
						`
					})
				)

				yield* withInProcessFetch(
					server.baseUrl,
					server.handler,
					Effect.gen(function* () {
						const clientAContext = yield* Layer.build(
							makeClientLayer({
								clientId: "clientA",
								syncRpcUrl,
								syncRpcAuthToken: token,
								pgliteDataDir: `memory://clientA-${crypto.randomUUID()}`
							})
						)

						const clientAActions = yield* defineClientActions.pipe(Effect.provide(clientAContext))
						const clientASync = yield* SyncService.pipe(Effect.provide(clientAContext))

						yield* setupClientNotes.pipe(Effect.provide(clientAContext))
						yield* clientASync.executeAction(
							clientAActions.createNoteWithId({
								id: noteId,
								content: "hello",
								project_id: projectId,
								timestamp: 1000
							})
						)
						yield* clientASync.performSync()

						const clientFreshContext = yield* Layer.build(
							makeClientLayer({
								clientId: "clientFresh",
								syncRpcUrl,
								syncRpcAuthToken: token,
								pgliteDataDir: `memory://clientFresh-${crypto.randomUUID()}`
							})
						)
						const clientFreshSync = yield* SyncService.pipe(Effect.provide(clientFreshContext))

						yield* setupClientNotes.pipe(Effect.provide(clientFreshContext))
						yield* defineClientActions.pipe(Effect.provide(clientFreshContext))
						yield* clientFreshSync.performSync()

						const restored = yield* getNoteContent(noteId).pipe(Effect.provide(clientFreshContext))
						expect(restored).toBe("hello")
						const freshLogCount = yield* Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient
							const rows = yield* sql<{ readonly count: number | string }>`
										SELECT count(*)::int as count
									FROM action_records
								`
							return typeof rows[0]?.count === "number"
								? rows[0].count
								: Number(rows[0]?.count ?? 0)
						}).pipe(Effect.provide(clientFreshContext))
						expect(freshLogCount).toBe(0)
						const serverCount = yield* runOnServerAsUser("userA")(getNoteCount)
						expect(serverCount).toBe(1)
					})
				)
			}),
		{ timeout: 30000 }
	)

	it.scoped(
		"bootstrap snapshot then tail sync applies subsequent remote actions",
		() =>
			Effect.gen(function* () {
				const secret = "supersecretvalue-supersecretvalue"
				const token = yield* Effect.promise(() =>
					signHs256Jwt({ secret, sub: "userA", aud: "authenticated" })
				)

				const server = yield* makeInProcessSyncRpcServer({
					dataDir: `memory://server-${crypto.randomUUID()}`,
					baseUrl: TestSyncRpcBaseUrl,
					configProvider: ConfigProvider.fromMap(
						new Map([
							["SYNC_JWT_SECRET", secret],
							["SYNC_JWT_AUD", "authenticated"]
						])
					)
				})

				const syncRpcUrl = `${server.baseUrl}/rpc`
				const runOnServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
					Effect.promise(() => Runtime.runPromise(server.runtime)(effect as any)) as Effect.Effect<
						A,
						E,
						never
					>

				const projectId = `project-${crypto.randomUUID()}`
				const noteId = crypto.randomUUID()

				yield* runOnServer(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient
						yield* sql`INSERT INTO projects (id) VALUES (${projectId}) ON CONFLICT DO NOTHING`
						yield* sql`
								INSERT INTO project_members (id, project_id, user_id)
								VALUES (${`${projectId}-userA`}, ${projectId}, 'userA')
								ON CONFLICT DO NOTHING
							`
					})
				)

				yield* withInProcessFetch(
					server.baseUrl,
					server.handler,
					Effect.gen(function* () {
						const clientAContext = yield* Layer.build(
							makeClientLayer({
								clientId: "clientA",
								syncRpcUrl,
								syncRpcAuthToken: token,
								pgliteDataDir: `memory://clientA-${crypto.randomUUID()}`
							})
						)

						const clientAActions = yield* defineClientActions.pipe(Effect.provide(clientAContext))
						const clientASync = yield* SyncService.pipe(Effect.provide(clientAContext))

						yield* setupClientNotes.pipe(Effect.provide(clientAContext))
						yield* clientASync.executeAction(
							clientAActions.createNoteWithId({
								id: noteId,
								content: "hello",
								project_id: projectId,
								timestamp: 1000
							})
						)
						yield* clientASync.performSync()

						const clientFreshContext = yield* Layer.build(
							makeClientLayer({
								clientId: "clientFresh",
								syncRpcUrl,
								syncRpcAuthToken: token,
								pgliteDataDir: `memory://clientFresh-${crypto.randomUUID()}`
							})
						)
						const clientFreshSync = yield* SyncService.pipe(Effect.provide(clientFreshContext))

						yield* setupClientNotes.pipe(Effect.provide(clientFreshContext))
						yield* defineClientActions.pipe(Effect.provide(clientFreshContext))
						yield* clientFreshSync.performSync()

						expect(yield* getNoteContent(noteId).pipe(Effect.provide(clientFreshContext))).toBe(
							"hello"
						)

						yield* waitForNextMillisecond

						yield* clientASync.executeAction(
							clientAActions.updateNoteContent({
								id: noteId,
								content: "world",
								timestamp: 2000
							})
						)
						yield* clientASync.performSync()

						yield* clientFreshSync.performSync()
						expect(yield* getNoteContent(noteId).pipe(Effect.provide(clientFreshContext))).toBe(
							"world"
						)
					})
				)
			}),
		{ timeout: 30000 }
	)

	it.scoped(
		"RLS isolates users across the HTTP RPC boundary",
		() =>
			Effect.gen(function* () {
				const secret = "supersecretvalue-supersecretvalue"
				const tokenA = yield* Effect.promise(() =>
					signHs256Jwt({ secret, sub: "userA", aud: "authenticated" })
				)
				const tokenB = yield* Effect.promise(() =>
					signHs256Jwt({ secret, sub: "userB", aud: "authenticated" })
				)

				const server = yield* makeInProcessSyncRpcServer({
					dataDir: `memory://server-${crypto.randomUUID()}`,
					baseUrl: TestSyncRpcBaseUrl,
					configProvider: ConfigProvider.fromMap(
						new Map([
							["SYNC_JWT_SECRET", secret],
							["SYNC_JWT_AUD", "authenticated"]
						])
					)
				})

				const syncRpcUrl = `${server.baseUrl}/rpc`
				const runOnServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
					Effect.promise(() => Runtime.runPromise(server.runtime)(effect as any)) as Effect.Effect<
						A,
						E,
						never
					>
				const runOnServerAsUser =
					(userId: string) =>
					<A, E, R>(effect: Effect.Effect<A, E, R>) =>
						runOnServer(
							Effect.gen(function* () {
								const sql = yield* SqlClient.SqlClient
								return yield* Effect.gen(function* () {
									yield* sql`SELECT set_config('synchrotron.user_id', ${userId}, true)`
									yield* sql`SELECT set_config('request.jwt.claim.sub', ${userId}, true)`
									return yield* effect
								}).pipe(sql.withTransaction)
							})
						)

				const noteId = crypto.randomUUID()
				const projectId = `project-${crypto.randomUUID()}`

				yield* runOnServer(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient
						yield* sql`INSERT INTO projects (id) VALUES (${projectId}) ON CONFLICT DO NOTHING`
						yield* sql`
							INSERT INTO project_members (id, project_id, user_id)
							VALUES (${`${projectId}-userA`}, ${projectId}, 'userA')
							ON CONFLICT DO NOTHING
						`
					})
				)

				yield* withInProcessFetch(
					server.baseUrl,
					server.handler,
					Effect.gen(function* () {
						const clientAContext = yield* Layer.build(
							makeClientLayer({
								clientId: "clientA",
								syncRpcUrl,
								syncRpcAuthToken: tokenA,
								pgliteDataDir: `memory://clientA-${crypto.randomUUID()}`
							})
						)
						yield* setupClientNotes.pipe(Effect.provide(clientAContext))
						const clientAActions = yield* defineClientActions.pipe(Effect.provide(clientAContext))
						const clientASync = yield* SyncService.pipe(Effect.provide(clientAContext))
						yield* clientASync.executeAction(
							clientAActions.createNoteWithId({
								id: noteId,
								content: "private",
								project_id: projectId,
								timestamp: 1000
							})
						)
						yield* clientASync.performSync()

						const clientBContext = yield* Layer.build(
							makeClientLayer({
								clientId: "clientB",
								syncRpcUrl,
								syncRpcAuthToken: tokenB,
								pgliteDataDir: `memory://clientB-${crypto.randomUUID()}`
							})
						)
						yield* setupClientNotes.pipe(Effect.provide(clientBContext))
						yield* defineClientActions.pipe(Effect.provide(clientBContext))
						const clientBSync = yield* SyncService.pipe(Effect.provide(clientBContext))
						yield* clientBSync.performSync()

						const bCount = yield* getNoteCount.pipe(Effect.provide(clientBContext))
						expect(bCount).toBe(0)

						const serverCountA = yield* runOnServerAsUser("userA")(getNoteCount)
						expect(serverCountA).toBe(1)

						const serverCountB = yield* runOnServerAsUser("userB")(getNoteCount)
						expect(serverCountB).toBe(0)
					})
				)
			}),
		{ timeout: 30000 }
	)

	it.scoped(
		"SYNC corrections propagate over HTTP and server materializes the final canonical overwrite",
		() =>
			Effect.gen(function* () {
				const secret = "supersecretvalue-supersecretvalue"
				const token = yield* Effect.promise(() =>
					signHs256Jwt({ secret, sub: "user-1", aud: "authenticated" })
				)

				const server = yield* makeInProcessSyncRpcServer({
					dataDir: `memory://server-${crypto.randomUUID()}`,
					baseUrl: TestSyncRpcBaseUrl,
					configProvider: ConfigProvider.fromMap(
						new Map([
							["SYNC_JWT_SECRET", secret],
							["SYNC_JWT_AUD", "authenticated"]
						])
					)
				})

				const syncRpcUrl = `${server.baseUrl}/rpc`
				const runOnServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
					Effect.promise(() => Runtime.runPromise(server.runtime)(effect as any)) as Effect.Effect<
						A,
						E,
						never
					>
				const runOnServerAsUser =
					(userId: string) =>
					<A, E, R>(effect: Effect.Effect<A, E, R>) =>
						runOnServer(
							Effect.gen(function* () {
								const sql = yield* SqlClient.SqlClient
								return yield* Effect.gen(function* () {
									yield* sql`SELECT set_config('synchrotron.user_id', ${userId}, true)`
									yield* sql`SELECT set_config('request.jwt.claim.sub', ${userId}, true)`
									return yield* effect
								}).pipe(sql.withTransaction)
							})
						)

				const mkClient = (clientId: string) =>
					Layer.build(
						makeClientLayer({
							clientId,
							syncRpcUrl,
							syncRpcAuthToken: token,
							pgliteDataDir: `memory://${clientId}-${crypto.randomUUID()}`
						})
					)

				yield* withInProcessFetch(
					server.baseUrl,
					server.handler,
					Effect.gen(function* () {
						const sourceContext = yield* mkClient("source")
						const clientAContext = yield* mkClient("clientA")
						const clientBContext = yield* mkClient("clientB")

						yield* setupClientNotes.pipe(Effect.provide(sourceContext))
						yield* setupClientNotes.pipe(Effect.provide(clientAContext))
						yield* setupClientNotes.pipe(Effect.provide(clientBContext))

						const sourceActions = yield* defineClientActions.pipe(Effect.provide(sourceContext))
						yield* defineClientActions.pipe(Effect.provide(clientAContext))
						yield* defineClientActions.pipe(Effect.provide(clientBContext))
						const sourceSync = yield* SyncService.pipe(Effect.provide(sourceContext))
						const clientASync = yield* SyncService.pipe(Effect.provide(clientAContext))
						const clientBSync = yield* SyncService.pipe(Effect.provide(clientBContext))

						const noteId = crypto.randomUUID()
						const projectId = `project-${crypto.randomUUID()}`

						yield* runOnServer(
							Effect.gen(function* () {
								const sql = yield* SqlClient.SqlClient
								yield* sql`INSERT INTO projects (id) VALUES (${projectId}) ON CONFLICT DO NOTHING`
								yield* sql`
									INSERT INTO project_members (id, project_id, user_id)
									VALUES (${`${projectId}-user-1`}, ${projectId}, 'user-1')
									ON CONFLICT DO NOTHING
								`
							})
						)

						yield* sourceSync.executeAction(
							sourceActions.createNoteWithId({
								id: noteId,
								content: "Initial",
								project_id: projectId,
								timestamp: 1000
							})
						)
						yield* sourceSync.performSync()

						yield* clientASync.performSync()
						yield* clientBSync.performSync()

						yield* sourceSync.executeAction(
							sourceActions.clientSpecificContent({
								id: noteId,
								baseContent: "Base",
								timestamp: 2000
							})
						)
						yield* sourceSync.performSync()

						// Client A receives base action, generates SYNC overwrite (Base-clientA), then uploads it.
						yield* clientASync.performSync()
						yield* clientASync.performSync()

						yield* waitForNextMillisecond

						// Client B receives base + A's SYNC, generates its own SYNC overwrite (Base-clientB), then uploads it.
						yield* clientBSync.performSync()
						yield* clientBSync.performSync()

						const serverContent = yield* runOnServerAsUser("user-1")(getNoteContent(noteId))
						expect(serverContent).toBe("Base-clientB")

						// (Optional sanity) once synced, both clients converge on the authoritative server state.
						yield* clientASync.performSync()
						yield* sourceSync.performSync()

						const aContent = yield* getNoteContent(noteId).pipe(Effect.provide(clientAContext))
						expect(aContent).toBe("Base-clientB")
					})
				)
			}),
		{ timeout: 30000 }
	)

	it.scoped(
		"SendLocalActions rejects with typed BehindHead error over RPC",
		() =>
			Effect.gen(function* () {
				const secret = "supersecretvalue-supersecretvalue"
				const token = yield* Effect.promise(() =>
					signHs256Jwt({ secret, sub: "userA", aud: "authenticated" })
				)

				const server = yield* makeInProcessSyncRpcServer({
					dataDir: `memory://server-${crypto.randomUUID()}`,
					baseUrl: TestSyncRpcBaseUrl,
					configProvider: ConfigProvider.fromMap(
						new Map([
							["SYNC_JWT_SECRET", secret],
							["SYNC_JWT_AUD", "authenticated"]
						])
					)
				})

				const syncRpcUrl = `${server.baseUrl}/rpc`
				const runOnServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
					Effect.promise(() => Runtime.runPromise(server.runtime)(effect as any)) as Effect.Effect<
						A,
						E,
						never
					>

				const projectId = `project-${crypto.randomUUID()}`
				yield* runOnServer(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient
						yield* sql`INSERT INTO projects (id) VALUES (${projectId}) ON CONFLICT DO NOTHING`
						yield* sql`
							INSERT INTO project_members (id, project_id, user_id)
							VALUES (${`${projectId}-userA`}, ${projectId}, 'userA')
							ON CONFLICT DO NOTHING
						`
					})
				)

				const remoteNoteId = crypto.randomUUID()
				const localNoteId = crypto.randomUUID()

				yield* withInProcessFetch(
					server.baseUrl,
					server.handler,
					Effect.gen(function* () {
						const clientBContext = yield* Layer.build(
							makeClientLayer({
								clientId: "clientB",
								syncRpcUrl,
								syncRpcAuthToken: token,
								pgliteDataDir: `memory://clientB-${crypto.randomUUID()}`
							})
						)
						yield* setupClientNotes.pipe(Effect.provide(clientBContext))
						const actionsB = yield* defineClientActions.pipe(Effect.provide(clientBContext))
						const syncB = yield* SyncService.pipe(Effect.provide(clientBContext))
						yield* syncB.executeAction(
							actionsB.createNoteWithId({
								id: remoteNoteId,
								content: "remote",
								project_id: projectId,
								timestamp: 1000
							})
						)
						yield* syncB.performSync()

						const clientAContext = yield* Layer.build(
							makeClientLayer({
								clientId: "clientA",
								syncRpcUrl,
								syncRpcAuthToken: token,
								pgliteDataDir: `memory://clientA-${crypto.randomUUID()}`
							})
						)
						yield* setupClientNotes.pipe(Effect.provide(clientAContext))
						const actionsA = yield* defineClientActions.pipe(Effect.provide(clientAContext))
						const syncA = yield* SyncService.pipe(Effect.provide(clientAContext))
						yield* syncA.executeAction(
							actionsA.createNoteWithId({
								id: localNoteId,
								content: "local",
								project_id: projectId,
								timestamp: 2000
							})
						)

						const actionRecordRepo = yield* ActionRecordRepo.pipe(Effect.provide(clientAContext))
						const actionModifiedRowRepo = yield* ActionModifiedRowRepo.pipe(
							Effect.provide(clientAContext)
						)
						const network = yield* SyncNetworkService.pipe(Effect.provide(clientAContext))

						const actionsToSend = yield* actionRecordRepo.allUnsynced()
						const amrsToSend = yield* actionModifiedRowRepo.allUnsynced()

						const sendAttempt = yield* network.sendLocalActions(actionsToSend, amrsToSend, 0).pipe(
							Effect.map((value) => ({ ok: true as const, value })),
							Effect.catchAll((error) => Effect.succeed({ ok: false as const, error }))
						)
						expect(sendAttempt.ok).toBe(false)
						if (!sendAttempt.ok) {
							expect(sendAttempt.error._tag).toBe("SendLocalActionsBehindHead")
							expect(sendAttempt.error).toBeInstanceOf(SendLocalActionsBehindHead)
							if (sendAttempt.error instanceof SendLocalActionsBehindHead) {
								expect(sendAttempt.error.basisServerIngestId).toBe(0)
								expect(sendAttempt.error.firstUnseenServerIngestId).toBeGreaterThan(0)
							}
						}
					})
				)
			}),
		{ timeout: 30000 }
	)
})
