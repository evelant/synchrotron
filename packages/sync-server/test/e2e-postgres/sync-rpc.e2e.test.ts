import { KeyValueStore } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { describe, expect, it } from "@effect/vitest"
import { makeSynchrotronClientLayer } from "@synchrotron/sync-client"
import { ActionRegistry } from "@synchrotron/sync-core/ActionRegistry"
import { ActionModifiedRowRepo } from "@synchrotron/sync-core/ActionModifiedRowRepo"
import { ActionRecordRepo } from "@synchrotron/sync-core/ActionRecordRepo"
import { ClientDbAdapter } from "@synchrotron/sync-core/ClientDbAdapter"
import { ClientIdOverride } from "@synchrotron/sync-core/ClientIdOverride"
import { ClockService } from "@synchrotron/sync-core/ClockService"
import { SyncNetworkService } from "@synchrotron/sync-core/SyncNetworkService"
import { SyncService } from "@synchrotron/sync-core/SyncService"
import { ConfigProvider, Effect, Layer, Runtime, Schema } from "effect"
import { SignJWT } from "jose"
import { makeInProcessSyncRpcServerPostgres } from "./harness"

const waitForNextMillisecond = Effect.sync(() => {
	const start = Date.now()
	while (Date.now() <= start) {
		// busy-wait: HLC uses Date.now(), not Effect TestClock
	}
})

const signHs256Jwt = (params: { readonly secret: string; readonly sub: string; readonly aud?: string }) =>
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
	const clockService = yield* ClockService

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
				const clientId = yield* clockService.getNodeId
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
	makeSynchrotronClientLayer(
		{
			syncRpcUrl: params.syncRpcUrl,
			syncRpcAuthToken: params.syncRpcAuthToken,
			electricSyncUrl: "http://unused",
			pglite: { dataDir: params.pgliteDataDir, debug: 0, relaxedDurability: true }
		},
		{ keyValueStoreLayer: KeyValueStore.layerMemory.pipe(Layer.fresh) }
	).pipe(Layer.provideMerge(Layer.succeed(ClientIdOverride, params.clientId)), Layer.provideMerge(Layer.scope))

describe("E2E (Postgres): SyncNetworkRpc over real Postgres", () => {
	it.scoped(
		"bootstrap from empty client DB uses server snapshot (no action replay)",
		() =>
			Effect.gen(function* () {
				const secret = "supersecretvalue-supersecretvalue"
				const token = yield* Effect.promise(() =>
					signHs256Jwt({ secret, sub: "userA", aud: "authenticated" })
				)

				const server = yield* makeInProcessSyncRpcServerPostgres({
					baseUrl: "http://synchrotron.test",
					configProvider: ConfigProvider.orElse(
						ConfigProvider.fromMap(
							new Map([
								["SYNC_JWT_SECRET", secret],
								["SYNC_JWT_AUD", "authenticated"]
							])
						),
						() => ConfigProvider.fromEnv()
					)
				})

				const syncRpcUrl = `${server.baseUrl}/rpc`
				const runOnServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
					Effect.promise(() => Runtime.runPromise(server.runtime)(effect as any)) as Effect.Effect<A, E, never>
				const runOnServerAsUser =
					(userId: string) =>
					<A, E, R>(effect: Effect.Effect<A, E, R>) =>
						runOnServer(
							Effect.gen(function* () {
								const sql = yield* SqlClient.SqlClient
								yield* sql`SELECT set_config('synchrotron.user_id', ${userId}, false)`
								return yield* effect
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
							return typeof rows[0]?.count === "number" ? rows[0].count : Number(rows[0]?.count ?? 0)
						}).pipe(Effect.provide(clientFreshContext))
						expect(freshLogCount).toBe(0)
						const serverCount = yield* runOnServerAsUser("userA")(getNoteCount)
						expect(serverCount).toBe(1)
					})
				)
			}),
			{ timeout: 120000 }
		)

	it.scoped(
		"bootstrap snapshot then tail sync applies subsequent remote actions",
		() =>
			Effect.gen(function* () {
				const secret = "supersecretvalue-supersecretvalue"
				const token = yield* Effect.promise(() =>
					signHs256Jwt({ secret, sub: "userA", aud: "authenticated" })
				)

				const server = yield* makeInProcessSyncRpcServerPostgres({
					baseUrl: "http://synchrotron.test",
					configProvider: ConfigProvider.orElse(
						ConfigProvider.fromMap(
							new Map([
								["SYNC_JWT_SECRET", secret],
								["SYNC_JWT_AUD", "authenticated"]
							])
						),
						() => ConfigProvider.fromEnv()
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

						expect(yield* getNoteContent(noteId).pipe(Effect.provide(clientFreshContext))).toBe("hello")

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
						expect(yield* getNoteContent(noteId).pipe(Effect.provide(clientFreshContext))).toBe("world")
					})
				)
			}),
		{ timeout: 120000 }
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

				const server = yield* makeInProcessSyncRpcServerPostgres({
					baseUrl: "http://synchrotron.test",
					configProvider: ConfigProvider.orElse(
						ConfigProvider.fromMap(
							new Map([
								["SYNC_JWT_SECRET", secret],
								["SYNC_JWT_AUD", "authenticated"]
							])
						),
						() => ConfigProvider.fromEnv()
					)
				})

				const syncRpcUrl = `${server.baseUrl}/rpc`
				const runOnServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
					Effect.promise(() => Runtime.runPromise(server.runtime)(effect as any)) as Effect.Effect<A, E, never>

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
								syncRpcAuthToken: tokenA,
								pgliteDataDir: `memory://clientA-${crypto.randomUUID()}`
							})
						)

						const clientAActions = yield* defineClientActions.pipe(Effect.provide(clientAContext))
						const clientASync = yield* SyncService.pipe(Effect.provide(clientAContext))

						yield* setupClientNotes.pipe(Effect.provide(clientAContext))
						yield* clientASync.executeAction(
							clientAActions.createNoteWithId({
								id: noteId,
								content: "secret",
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
						const clientBSync = yield* SyncService.pipe(Effect.provide(clientBContext))

						yield* setupClientNotes.pipe(Effect.provide(clientBContext))
						yield* defineClientActions.pipe(Effect.provide(clientBContext))
						yield* clientBSync.performSync()

						const bSees = yield* getNoteContent(noteId).pipe(Effect.provide(clientBContext))
						expect(bSees).toBeNull()
					})
				)
			}),
		{ timeout: 120000 }
	)

		it.scoped(
			"SYNC corrections propagate over HTTP and server materializes the final canonical overwrite",
			() =>
				Effect.gen(function* () {
				const secret = "supersecretvalue-supersecretvalue"
				const tokenA = yield* Effect.promise(() =>
					signHs256Jwt({ secret, sub: "userA", aud: "authenticated" })
				)
				const tokenB = yield* Effect.promise(() =>
					signHs256Jwt({ secret, sub: "userB", aud: "authenticated" })
				)

				const server = yield* makeInProcessSyncRpcServerPostgres({
					baseUrl: "http://synchrotron.test",
					configProvider: ConfigProvider.orElse(
						ConfigProvider.fromMap(
							new Map([
								["SYNC_JWT_SECRET", secret],
								["SYNC_JWT_AUD", "authenticated"]
							])
						),
						() => ConfigProvider.fromEnv()
					)
				})

				const syncRpcUrl = `${server.baseUrl}/rpc`
				const runOnServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
					Effect.promise(() => Runtime.runPromise(server.runtime)(effect as any)) as Effect.Effect<A, E, never>
				const runOnServerAsUser =
					(userId: string) =>
					<A, E, R>(effect: Effect.Effect<A, E, R>) =>
						runOnServer(
							Effect.gen(function* () {
								const sql = yield* SqlClient.SqlClient
								yield* sql`SELECT set_config('synchrotron.user_id', ${userId}, false)`
								return yield* effect
							})
						)

				const projectId = `project-${crypto.randomUUID()}`
				const noteId = crypto.randomUUID()

				yield* runOnServer(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient
						yield* sql`INSERT INTO projects (id) VALUES (${projectId}) ON CONFLICT DO NOTHING`
						yield* sql`
							INSERT INTO project_members (id, project_id, user_id)
							VALUES
								(${`${projectId}-userA`}, ${projectId}, 'userA'),
								(${`${projectId}-userB`}, ${projectId}, 'userB')
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
						const clientBContext = yield* Layer.build(
							makeClientLayer({
								clientId: "clientB",
								syncRpcUrl,
								syncRpcAuthToken: tokenB,
								pgliteDataDir: `memory://clientB-${crypto.randomUUID()}`
							})
						)

						yield* setupClientNotes.pipe(Effect.provide(clientAContext))
						yield* setupClientNotes.pipe(Effect.provide(clientBContext))

						const actionsA = yield* defineClientActions.pipe(Effect.provide(clientAContext))
						const actionsB = yield* defineClientActions.pipe(Effect.provide(clientBContext))
						const syncA = yield* SyncService.pipe(Effect.provide(clientAContext))
						const syncB = yield* SyncService.pipe(Effect.provide(clientBContext))

						yield* syncA.executeAction(
							actionsA.createNoteWithId({
								id: noteId,
								content: "base",
								project_id: projectId,
								timestamp: 1000
							})
						)
						yield* syncA.performSync()

						yield* waitForNextMillisecond
						yield* syncB.performSync()

						// Both clients write different deterministic values to the same row.
						yield* waitForNextMillisecond
						yield* syncA.executeAction(actionsA.clientSpecificContent({ id: noteId, baseContent: "v", timestamp: 2000 }))
						yield* syncA.performSync()

						yield* waitForNextMillisecond
						yield* syncB.executeAction(actionsB.clientSpecificContent({ id: noteId, baseContent: "v", timestamp: 3000 }))
						yield* syncB.performSync()

						// Pull + reconcile.
						yield* waitForNextMillisecond
						yield* syncA.performSync()
						yield* waitForNextMillisecond
						yield* syncB.performSync()

						const finalOnServer = yield* runOnServerAsUser("userA")(getNoteContent(noteId))
						// Canonical order yields clientB’s write last (higher HLC after waits).
						expect(finalOnServer).toBe(`v-clientB`)
					})
				)
				}),
			{ timeout: 120000 }
		)

		it.scoped(
			"duplicate sendLocalActions is idempotent over the HTTP RPC boundary",
			() =>
				Effect.gen(function* () {
					const secret = "supersecretvalue-supersecretvalue"
					const tokenA = yield* Effect.promise(() =>
						signHs256Jwt({ secret, sub: "userA", aud: "authenticated" })
					)

					const server = yield* makeInProcessSyncRpcServerPostgres({
						baseUrl: "http://synchrotron.test",
						configProvider: ConfigProvider.orElse(
							ConfigProvider.fromMap(
								new Map([
									["SYNC_JWT_SECRET", secret],
									["SYNC_JWT_AUD", "authenticated"]
								])
							),
							() => ConfigProvider.fromEnv()
						)
					})

					const syncRpcUrl = `${server.baseUrl}/rpc`
					const runOnServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
						Effect.promise(() => Runtime.runPromise(server.runtime)(effect as any)) as Effect.Effect<A, E, never>
					const runOnServerAsUser =
						(userId: string) =>
						<A, E, R>(effect: Effect.Effect<A, E, R>) =>
							runOnServer(
								Effect.gen(function* () {
									const sql = yield* SqlClient.SqlClient
									yield* sql`SELECT set_config('synchrotron.user_id', ${userId}, false)`
									return yield* effect
								})
							)

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
									syncRpcAuthToken: tokenA,
									pgliteDataDir: `memory://clientA-${crypto.randomUUID()}`
								})
							)

							const clientAActions = yield* defineClientActions.pipe(Effect.provide(clientAContext))
							yield* setupClientNotes.pipe(Effect.provide(clientAContext))

							const clientASync = yield* SyncService.pipe(Effect.provide(clientAContext))
							const actionRecordRepo = yield* ActionRecordRepo.pipe(Effect.provide(clientAContext))
							const actionModifiedRowRepo = yield* ActionModifiedRowRepo.pipe(Effect.provide(clientAContext))
							const network = yield* SyncNetworkService.pipe(Effect.provide(clientAContext))

							yield* clientASync.executeAction(
								clientAActions.createNoteWithId({
									id: noteId,
									content: "hello",
									project_id: projectId,
									timestamp: 1000
								})
							)

							const actionsToSend = yield* actionRecordRepo.allUnsynced()
							const amrsToSend = yield* actionModifiedRowRepo.allUnsynced()

							const firstSend = yield* network.sendLocalActions(actionsToSend, amrsToSend, 0)
							expect(firstSend).toBe(true)

							const countAfterFirst = yield* runOnServerAsUser("userA")(getNoteCount)
							expect(countAfterFirst).toBe(1)

							const secondSend = yield* network.sendLocalActions(actionsToSend, amrsToSend, 0)
							expect(secondSend).toBe(true)

							const countAfterSecond = yield* runOnServerAsUser("userA")(getNoteCount)
							expect(countAfterSecond).toBe(1)

							const serverActionCount = yield* runOnServerAsUser("userA")(
								Effect.gen(function* () {
									const sql = yield* SqlClient.SqlClient
									const rows = yield* sql<{ readonly count: number | string }>`
										SELECT count(*)::int as count
										FROM action_records
										WHERE id IN ${sql.in(actionsToSend.map((a) => a.id))}
									`
									return typeof rows[0]?.count === "number" ? rows[0].count : Number(rows[0]?.count ?? 0)
								})
							)
							expect(serverActionCount).toBe(actionsToSend.length)

							const serverAmrCount = yield* runOnServerAsUser("userA")(
								Effect.gen(function* () {
									const sql = yield* SqlClient.SqlClient
									const rows = yield* sql<{ readonly count: number | string }>`
										SELECT count(*)::int as count
										FROM action_modified_rows
										WHERE action_record_id IN ${sql.in(actionsToSend.map((a) => a.id))}
									`
									return typeof rows[0]?.count === "number" ? rows[0].count : Number(rows[0]?.count ?? 0)
								})
							)
							expect(serverAmrCount).toBe(amrsToSend.length)
						})
					)
				}),
			{ timeout: 120000 }
		)

		it.scoped(
			"head gate rejects stale basisServerIngestId; succeeds after fetch+reconcile",
			() =>
				Effect.gen(function* () {
					const secret = "supersecretvalue-supersecretvalue"
					const tokenA = yield* Effect.promise(() =>
						signHs256Jwt({ secret, sub: "userA", aud: "authenticated" })
					)
					const tokenB = yield* Effect.promise(() =>
						signHs256Jwt({ secret, sub: "userB", aud: "authenticated" })
					)

					const server = yield* makeInProcessSyncRpcServerPostgres({
						baseUrl: "http://synchrotron.test",
						configProvider: ConfigProvider.orElse(
							ConfigProvider.fromMap(
								new Map([
									["SYNC_JWT_SECRET", secret],
									["SYNC_JWT_AUD", "authenticated"]
								])
							),
							() => ConfigProvider.fromEnv()
						)
					})

					const syncRpcUrl = `${server.baseUrl}/rpc`
					const runOnServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
						Effect.promise(() => Runtime.runPromise(server.runtime)(effect as any)) as Effect.Effect<A, E, never>
					const runOnServerAsUser =
						(userId: string) =>
						<A, E, R>(effect: Effect.Effect<A, E, R>) =>
							runOnServer(
								Effect.gen(function* () {
									const sql = yield* SqlClient.SqlClient
									yield* sql`SELECT set_config('synchrotron.user_id', ${userId}, false)`
									return yield* effect
								})
							)

					const projectId = `project-${crypto.randomUUID()}`
					const remoteNoteId = crypto.randomUUID()
					const localNoteId = crypto.randomUUID()

					yield* runOnServer(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient
							yield* sql`INSERT INTO projects (id) VALUES (${projectId}) ON CONFLICT DO NOTHING`
							yield* sql`
								INSERT INTO project_members (id, project_id, user_id)
								VALUES
									(${`${projectId}-userA`}, ${projectId}, 'userA'),
									(${`${projectId}-userB`}, ${projectId}, 'userB')
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
							const clientBContext = yield* Layer.build(
								makeClientLayer({
									clientId: "clientB",
									syncRpcUrl,
									syncRpcAuthToken: tokenB,
									pgliteDataDir: `memory://clientB-${crypto.randomUUID()}`
								})
							)

							yield* setupClientNotes.pipe(Effect.provide(clientAContext))
							yield* setupClientNotes.pipe(Effect.provide(clientBContext))

							const actionsA = yield* defineClientActions.pipe(Effect.provide(clientAContext))
							const actionsB = yield* defineClientActions.pipe(Effect.provide(clientBContext))

							const syncA = yield* SyncService.pipe(Effect.provide(clientAContext))
							const syncB = yield* SyncService.pipe(Effect.provide(clientBContext))

							// Client B uploads a remote action first.
							yield* syncB.executeAction(
								actionsB.createNoteWithId({
									id: remoteNoteId,
									content: "remote",
									project_id: projectId,
									timestamp: 1000
								})
							)
							yield* syncB.performSync()

							// Client A prepares a local action but attempts to upload with a stale basis cursor.
							yield* syncA.executeAction(
								actionsA.createNoteWithId({
									id: localNoteId,
									content: "local",
									project_id: projectId,
									timestamp: 2000
								})
							)

							const actionRecordRepo = yield* ActionRecordRepo.pipe(Effect.provide(clientAContext))
							const actionModifiedRowRepo = yield* ActionModifiedRowRepo.pipe(Effect.provide(clientAContext))
							const network = yield* SyncNetworkService.pipe(Effect.provide(clientAContext))

							const actionsToSend = yield* actionRecordRepo.allUnsynced()
							const amrsToSend = yield* actionModifiedRowRepo.allUnsynced()

							const sendAttempt = yield* network.sendLocalActions(actionsToSend, amrsToSend, 0).pipe(
								Effect.map((value) => ({ ok: true as const, value })),
								Effect.catchAll((error) => Effect.succeed({ ok: false as const, error }))
							)
							expect(sendAttempt.ok).toBe(false)
							if (!sendAttempt.ok) {
								expect(sendAttempt.error.message).toContain("behind the server ingestion head")
							}

							const serverCountBefore = yield* runOnServerAsUser("userA")(getNoteCount)
							expect(serverCountBefore).toBe(1)

							// Now do the normal sync flow: fetch remote actions, reconcile, then retry upload.
							yield* syncA.performSync()

							const serverCountAfter = yield* runOnServerAsUser("userA")(getNoteCount)
							expect(serverCountAfter).toBe(2)
						})
					)
				}),
			{ timeout: 120000 }
		)

		it.scoped(
			"late-arriving older action triggers server rollback+replay (Postgres materialization)",
			() =>
				Effect.gen(function* () {
					const secret = "supersecretvalue-supersecretvalue"
					const tokenA = yield* Effect.promise(() =>
						signHs256Jwt({ secret, sub: "userA", aud: "authenticated" })
					)
					const tokenB = yield* Effect.promise(() =>
						signHs256Jwt({ secret, sub: "userB", aud: "authenticated" })
					)

					const server = yield* makeInProcessSyncRpcServerPostgres({
						baseUrl: "http://synchrotron.test",
						configProvider: ConfigProvider.orElse(
							ConfigProvider.fromMap(
								new Map([
									["SYNC_JWT_SECRET", secret],
									["SYNC_JWT_AUD", "authenticated"]
								])
							),
							() => ConfigProvider.fromEnv()
						)
					})

					const syncRpcUrl = `${server.baseUrl}/rpc`
					const runOnServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
						Effect.promise(() => Runtime.runPromise(server.runtime)(effect as any)) as Effect.Effect<A, E, never>
					const runOnServerAsUser =
						(userId: string) =>
						<A, E, R>(effect: Effect.Effect<A, E, R>) =>
							runOnServer(
								Effect.gen(function* () {
									const sql = yield* SqlClient.SqlClient
									yield* sql`SELECT set_config('synchrotron.user_id', ${userId}, false)`
									return yield* effect
								})
							)

					const projectId = `project-${crypto.randomUUID()}`
					const noteId = crypto.randomUUID()

					yield* runOnServer(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient
							yield* sql`INSERT INTO projects (id) VALUES (${projectId}) ON CONFLICT DO NOTHING`
							yield* sql`
								INSERT INTO project_members (id, project_id, user_id)
								VALUES
									(${`${projectId}-userA`}, ${projectId}, 'userA'),
									(${`${projectId}-userB`}, ${projectId}, 'userB')
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
							const clientBContext = yield* Layer.build(
								makeClientLayer({
									clientId: "clientB",
									syncRpcUrl,
									syncRpcAuthToken: tokenB,
									pgliteDataDir: `memory://clientB-${crypto.randomUUID()}`
								})
							)

							yield* setupClientNotes.pipe(Effect.provide(clientAContext))
							yield* setupClientNotes.pipe(Effect.provide(clientBContext))

							const actionsA = yield* defineClientActions.pipe(Effect.provide(clientAContext))
							const actionsB = yield* defineClientActions.pipe(Effect.provide(clientBContext))
							const syncA = yield* SyncService.pipe(Effect.provide(clientAContext))
							const syncB = yield* SyncService.pipe(Effect.provide(clientBContext))

							// Create a base row that both clients can see.
							yield* syncA.executeAction(
								actionsA.createNoteWithId({
									id: noteId,
									content: "base",
									project_id: projectId,
									timestamp: 1000
								})
							)
							yield* syncA.performSync()

							yield* waitForNextMillisecond
							yield* syncB.performSync()

							// Client A creates an older-HLC update but stays offline (does not upload yet).
							yield* waitForNextMillisecond
							yield* syncA.executeAction(
								actionsA.clientSpecificContent({
									id: noteId,
									baseContent: "v",
									timestamp: 2000
								})
							)

							// Client B creates a newer update and uploads it.
							yield* waitForNextMillisecond
							yield* syncB.executeAction(
								actionsB.clientSpecificContent({
									id: noteId,
									baseContent: "v",
									timestamp: 3000
								})
							)
							yield* syncB.performSync()

							const serverBefore = yield* runOnServerAsUser("userA")(getNoteContent(noteId))
							expect(serverBefore).toBe("v-clientB")

							// Now client A goes online and uploads its older action. The server must rollback+replay
							// so the newer (clientB) state still wins.
							yield* waitForNextMillisecond
							yield* syncA.performSync()

							const serverAfter = yield* runOnServerAsUser("userA")(getNoteContent(noteId))
							expect(serverAfter).toBe("v-clientB")
						})
					)
				}),
			{ timeout: 120000 }
		)

		it.scoped(
			"late-arriving older action forces replay of multiple suffix actions (server rollback+replay)",
			() =>
				Effect.gen(function* () {
					const secret = "supersecretvalue-supersecretvalue"
					const tokenA = yield* Effect.promise(() =>
						signHs256Jwt({ secret, sub: "userA", aud: "authenticated" })
					)
					const tokenB = yield* Effect.promise(() =>
						signHs256Jwt({ secret, sub: "userB", aud: "authenticated" })
					)
					const tokenC = yield* Effect.promise(() =>
						signHs256Jwt({ secret, sub: "userC", aud: "authenticated" })
					)

					const server = yield* makeInProcessSyncRpcServerPostgres({
						baseUrl: "http://synchrotron.test",
						configProvider: ConfigProvider.orElse(
							ConfigProvider.fromMap(
								new Map([
									["SYNC_JWT_SECRET", secret],
									["SYNC_JWT_AUD", "authenticated"]
								])
							),
							() => ConfigProvider.fromEnv()
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
									yield* sql`SELECT set_config('synchrotron.user_id', ${userId}, false)`
									return yield* effect
								})
							)

					const projectId = `project-${crypto.randomUUID()}`
					const noteId = crypto.randomUUID()

					yield* runOnServer(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient
							yield* sql`INSERT INTO projects (id) VALUES (${projectId}) ON CONFLICT DO NOTHING`
							yield* sql`
								INSERT INTO project_members (id, project_id, user_id)
								VALUES
									(${`${projectId}-userA`}, ${projectId}, 'userA'),
									(${`${projectId}-userB`}, ${projectId}, 'userB'),
									(${`${projectId}-userC`}, ${projectId}, 'userC')
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
							const clientBContext = yield* Layer.build(
								makeClientLayer({
									clientId: "clientB",
									syncRpcUrl,
									syncRpcAuthToken: tokenB,
									pgliteDataDir: `memory://clientB-${crypto.randomUUID()}`
								})
							)
							const clientCContext = yield* Layer.build(
								makeClientLayer({
									clientId: "clientC",
									syncRpcUrl,
									syncRpcAuthToken: tokenC,
									pgliteDataDir: `memory://clientC-${crypto.randomUUID()}`
								})
							)

							yield* setupClientNotes.pipe(Effect.provide(clientAContext))
							yield* setupClientNotes.pipe(Effect.provide(clientBContext))
							yield* setupClientNotes.pipe(Effect.provide(clientCContext))

							const actionsA = yield* defineClientActions.pipe(Effect.provide(clientAContext))
							const actionsB = yield* defineClientActions.pipe(Effect.provide(clientBContext))
							const actionsC = yield* defineClientActions.pipe(Effect.provide(clientCContext))

							const syncA = yield* SyncService.pipe(Effect.provide(clientAContext))
							const syncB = yield* SyncService.pipe(Effect.provide(clientBContext))
							const syncC = yield* SyncService.pipe(Effect.provide(clientCContext))

							// Create base row.
							yield* syncA.executeAction(
								actionsA.createNoteWithId({
									id: noteId,
									content: "base",
									project_id: projectId,
									timestamp: 1000
								})
							)
							yield* syncA.performSync()

							yield* waitForNextMillisecond
							yield* syncB.performSync()
							yield* waitForNextMillisecond
							yield* syncC.performSync()

							// Client A creates an older update but stays offline.
							yield* waitForNextMillisecond
							yield* syncA.executeAction(
								actionsA.clientSpecificContent({
									id: noteId,
									baseContent: "v",
									timestamp: 2000
								})
							)

							// Client B and C create newer updates and upload them.
							yield* waitForNextMillisecond
							yield* syncB.executeAction(
								actionsB.clientSpecificContent({
									id: noteId,
									baseContent: "v",
									timestamp: 3000
								})
							)
							yield* syncB.performSync()

							yield* waitForNextMillisecond
							yield* syncC.executeAction(
								actionsC.clientSpecificContent({
									id: noteId,
									baseContent: "v",
									timestamp: 4000
								})
							)
							yield* syncC.performSync()

							const serverBefore = yield* runOnServerAsUser("userA")(getNoteContent(noteId))
							expect(serverBefore).toBe("v-clientC")

							// Client A uploads its older action. Server must rollback+replay across both suffix
							// actions so the latest (clientC) still wins.
							yield* waitForNextMillisecond
							yield* syncA.performSync()

							const serverAfter = yield* runOnServerAsUser("userA")(getNoteContent(noteId))
							expect(serverAfter).toBe("v-clientC")
						})
					)
				}),
			{ timeout: 120000 }
		)
	})
