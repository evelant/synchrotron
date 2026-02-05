import { KeyValueStore } from "@effect/platform"
import * as PlatformError from "@effect/platform/Error"
import { SqlClient } from "@effect/sql"
import {
	Badge,
	Box,
	Button,
	Card,
	Checkbox,
	Container,
	Flex,
	Heading,
	Separator,
	Text,
	TextField
} from "@radix-ui/themes"
import {
	makeSynchrotronClientLayer,
	makeSynchrotronElectricClientLayer
} from "@synchrotron/sync-client"
import {
	ClientClockState,
	ClientDbAdapter,
	SyncService,
	type ActionExecutionError
} from "@synchrotron/sync-core"
import { ElectricSyncService } from "@synchrotron/sync-client/electric/ElectricSyncService"
import {
	makeOtelWebOtlpLoggerLayer,
	makeOtelWebOtlpMetricsLayer,
	makeOtelWebSdkLayer
} from "@synchrotron/observability/web"
import { TodoActions } from "../actions"
import logo from "../assets/logo.svg"
import { setupClientDatabase } from "../db/setup"
import type { Todo } from "../db/schema"
import { useReactiveTodos } from "../db/electric"
import { TodoRepo } from "../db/repositories"
import { RuntimeProvider, useRuntime } from "../runtime"
import { Clock, Effect, Layer, Logger, LogLevel, ManagedRuntime, Option } from "effect"
import React, { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react"

type TransportMode = "rpc-poll" | "electric"

const metaEnv = (import.meta as any).env as Partial<Record<string, string>> | undefined

const viteServerUrlFromProcessEnv = (() => {
	try {
		return process.env.VITE_SERVER_URL
	} catch {
		return undefined
	}
})()

const viteElectricUrlFromProcessEnv = (() => {
	try {
		return process.env.VITE_ELECTRIC_URL
	} catch {
		return undefined
	}
})()

const viteTodoProjectIdFromProcessEnv = (() => {
	try {
		return process.env.VITE_TODO_PROJECT_ID
	} catch {
		return undefined
	}
})()

const viteSyncUserIdFromProcessEnv = (() => {
	try {
		return process.env.VITE_SYNC_USER_ID
	} catch {
		return undefined
	}
})()

const viteSyncUserIdAFromProcessEnv = (() => {
	try {
		return process.env.VITE_SYNC_USER_ID_A
	} catch {
		return undefined
	}
})()

const viteSyncUserIdBFromProcessEnv = (() => {
	try {
		return process.env.VITE_SYNC_USER_ID_B
	} catch {
		return undefined
	}
})()

const viteSyncRpcAuthTokenFromProcessEnv = (() => {
	try {
		return process.env.VITE_SYNC_RPC_AUTH_TOKEN
	} catch {
		return undefined
	}
})()

const viteSyncRpcAuthTokenAFromProcessEnv = (() => {
	try {
		return process.env.VITE_SYNC_RPC_AUTH_TOKEN_A
	} catch {
		return undefined
	}
})()

const viteSyncRpcAuthTokenBFromProcessEnv = (() => {
	try {
		return process.env.VITE_SYNC_RPC_AUTH_TOKEN_B
	} catch {
		return undefined
	}
})()

const viteOtelEnabledFromProcessEnv = (() => {
	try {
		return process.env.VITE_OTEL_ENABLED
	} catch {
		return undefined
	}
})()

const viteOtelLogsEnabledFromProcessEnv = (() => {
	try {
		return process.env.VITE_OTEL_LOGS_ENABLED
	} catch {
		return undefined
	}
})()

const viteOtelServiceNameFromProcessEnv = (() => {
	try {
		return process.env.VITE_OTEL_SERVICE_NAME
	} catch {
		return undefined
	}
})()

const viteOtelTracesEndpointFromProcessEnv = (() => {
	try {
		return process.env.VITE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
	} catch {
		return undefined
	}
})()

const viteOtelLogsEndpointFromProcessEnv = (() => {
	try {
		return process.env.VITE_OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
	} catch {
		return undefined
	}
})()

const viteOtelMetricsEnabledFromProcessEnv = (() => {
	try {
		return process.env.VITE_OTEL_METRICS_ENABLED
	} catch {
		return undefined
	}
})()

const viteOtelMetricsEndpointFromProcessEnv = (() => {
	try {
		return process.env.VITE_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
	} catch {
		return undefined
	}
})()

const defaults = {
	serverUrl: metaEnv?.VITE_SERVER_URL ?? viteServerUrlFromProcessEnv ?? "http://localhost:3010",
	syncRpcAuthTokenA:
		metaEnv?.VITE_SYNC_RPC_AUTH_TOKEN_A ??
		metaEnv?.VITE_SYNC_RPC_AUTH_TOKEN ??
		viteSyncRpcAuthTokenAFromProcessEnv ??
		viteSyncRpcAuthTokenFromProcessEnv ??
		undefined,
	syncRpcAuthTokenB:
		metaEnv?.VITE_SYNC_RPC_AUTH_TOKEN_B ??
		metaEnv?.VITE_SYNC_RPC_AUTH_TOKEN ??
		viteSyncRpcAuthTokenBFromProcessEnv ??
		viteSyncRpcAuthTokenFromProcessEnv ??
		undefined,
	userIdA:
		metaEnv?.VITE_SYNC_USER_ID_A ??
		metaEnv?.VITE_SYNC_USER_ID ??
		viteSyncUserIdAFromProcessEnv ??
		viteSyncUserIdFromProcessEnv ??
		"user1",
	userIdB: metaEnv?.VITE_SYNC_USER_ID_B ?? viteSyncUserIdBFromProcessEnv ?? "user2",
	projectId: metaEnv?.VITE_TODO_PROJECT_ID ?? viteTodoProjectIdFromProcessEnv ?? "project-demo",
	electricUrl:
		metaEnv?.VITE_ELECTRIC_URL ?? viteElectricUrlFromProcessEnv ?? "http://localhost:5133",
	otelEnabled: metaEnv?.VITE_OTEL_ENABLED ?? viteOtelEnabledFromProcessEnv ?? "true",
	otelLogsEnabled: metaEnv?.VITE_OTEL_LOGS_ENABLED ?? viteOtelLogsEnabledFromProcessEnv ?? "false",
	otelServiceName:
		metaEnv?.VITE_OTEL_SERVICE_NAME ??
		viteOtelServiceNameFromProcessEnv ??
		"synchrotron-example-web",
	otelTracesEndpoint:
		metaEnv?.VITE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? viteOtelTracesEndpointFromProcessEnv ?? "",
	otelLogsEndpoint:
		metaEnv?.VITE_OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? viteOtelLogsEndpointFromProcessEnv ?? "",
	otelMetricsEnabled:
		metaEnv?.VITE_OTEL_METRICS_ENABLED ?? viteOtelMetricsEnabledFromProcessEnv ?? "false",
	otelMetricsEndpoint:
		metaEnv?.VITE_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? viteOtelMetricsEndpointFromProcessEnv ?? ""
} as const

const parseBooleanEnv = (value: string, fallback: boolean) => {
	const normalized = value.trim().toLowerCase()
	if (normalized === "true" || normalized === "1" || normalized === "yes") return true
	if (normalized === "false" || normalized === "0" || normalized === "no") return false
	return fallback
}

const normalizeRpcUrl = (serverUrl: string) => {
	if (serverUrl.endsWith("/rpc")) return serverUrl
	return `${serverUrl.replace(/\/+$/, "")}/rpc`
}

const makeClientIdbDataDir = (clientKey: string) => `idb://todo-app-${clientKey}`
const makeKvPrefix = (clientKey: string) => `synchrotron.todo-app-web.${clientKey}.`

const resetClientDatabase = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const clientDbAdapter = yield* ClientDbAdapter
	yield* Effect.logInfo("todoAppWeb.resetLocalDb.start", { dbDialect: clientDbAdapter.dialect })

	yield* clientDbAdapter
		.withPatchTrackingDisabled(
			Effect.gen(function* () {
				yield* sql`DELETE FROM todos`.raw
				yield* sql`DELETE FROM local_applied_action_ids`.raw
				yield* sql`DELETE FROM action_modified_rows`.raw
				yield* sql`DELETE FROM action_records`.raw
				yield* sql`DELETE FROM client_sync_status`.raw
			})
		)
		.pipe(sql.withTransaction)

	yield* Effect.logInfo("todoAppWeb.resetLocalDb.done", { dbDialect: clientDbAdapter.dialect })
})

const deleteIndexedDbDatabaseByName = async (
	name: string,
	options?: { readonly timeoutMs?: number }
) =>
	new Promise<void>((resolve, reject) => {
		const timeoutMs = options?.timeoutMs ?? 250
		const req = indexedDB.deleteDatabase(name)

		let settled = false
		const settle = (f: () => void) => {
			if (settled) return
			settled = true
			clearTimeout(timeoutId)
			f()
		}

		// Best-effort: if deletion is blocked by an open handle, it may still succeed shortly after
		// (e.g. once the DB connection closes). Do not hard-fail the reset flow.
		const timeoutId = setTimeout(() => settle(resolve), timeoutMs)

		req.onsuccess = () => settle(resolve)
		req.onerror = () =>
			settle(() => reject(req.error ?? new Error(`Failed to delete IndexedDB database: ${name}`)))
		req.onblocked = () => {
			// Intentionally do nothing: allow onsuccess to fire, or fall back to timeout.
		}
	})

const deleteIdbDatabase = async (dataDir: string) => {
	if (!dataDir.startsWith("idb://")) return
	const baseName = dataDir.slice("idb://".length)

	// PGlite's internal IndexedDB name is not guaranteed to be exactly `baseName`,
	// so delete a conservative set of likely names + any exact matches we can discover.
	const candidates = new Set<string>([
		baseName,
		`pglite-${baseName}`,
		`pglite:${baseName}`,
		`/pglite/${baseName}`
	])

	if (typeof indexedDB.databases === "function") {
		try {
			const dbs = await indexedDB.databases()
			for (const db of dbs) {
				const name = db.name
				if (!name) continue
				if (name === baseName || name.includes(baseName)) {
					candidates.add(name)
				}
			}
		} catch {
			// best-effort discovery only
		}
	}

	for (const name of candidates) {
		try {
			await deleteIndexedDbDatabaseByName(name)
		} catch (e) {
			console.warn("Failed to delete IndexedDB database (best-effort)", name, e)
		}
	}
}

const clearLocalStoragePrefix = (prefix: string) => {
	for (let i = localStorage.length - 1; i >= 0; i--) {
		const key = localStorage.key(i)
		if (!key) continue
		if (key.startsWith(prefix)) localStorage.removeItem(key)
	}
}

const makeLocalStorageKeyValueStoreLayer = (prefix: string) =>
	Layer.sync(KeyValueStore.KeyValueStore, () => {
		const prefixed = (key: string) => `${prefix}${key}`
		const storageError = (props: {
			readonly method: string
			readonly description: string
			readonly pathOrDescriptor?: string | number | undefined
		}) =>
			new PlatformError.SystemError({
				reason: "PermissionDenied",
				module: "KeyValueStore",
				...props
			})

		return KeyValueStore.makeStringOnly({
			get: (key: string) =>
				Effect.try({
					try: () => Option.fromNullable(localStorage.getItem(prefixed(key))),
					catch: () =>
						storageError({
							method: "get",
							pathOrDescriptor: key,
							description: `Unable to get key ${prefixed(key)}`
						})
				}),
			set: (key: string, value: string) =>
				Effect.try({
					try: () => localStorage.setItem(prefixed(key), value),
					catch: () =>
						storageError({
							method: "set",
							pathOrDescriptor: key,
							description: `Unable to set key ${prefixed(key)}`
						})
				}),
			remove: (key: string) =>
				Effect.try({
					try: () => localStorage.removeItem(prefixed(key)),
					catch: () =>
						storageError({
							method: "remove",
							pathOrDescriptor: key,
							description: `Unable to remove key ${prefixed(key)}`
						})
				}),
			clear: Effect.try({
				try: () => clearLocalStoragePrefix(prefix),
				catch: () =>
					storageError({
						method: "clear",
						description: `Unable to clear localStorage prefix ${prefix}`
					})
			}),
			size: Effect.try({
				try: () => {
					let count = 0
					for (let i = 0; i < localStorage.length; i++) {
						const key = localStorage.key(i)
						if (key && key.startsWith(prefix)) count++
					}
					return count
				},
				catch: () =>
					storageError({
						method: "size",
						description: `Unable to get size for localStorage prefix ${prefix}`
					})
			})
		})
	})

const makeClientLayer = (options: {
	readonly clientKey: string
	readonly transportMode: TransportMode
	readonly userId: string
}) => {
	const dataDir = makeClientIdbDataDir(options.clientKey)
	const kvPrefix = makeKvPrefix(options.clientKey)
	const syncRpcUrl = normalizeRpcUrl(defaults.serverUrl)
	const syncRpcAuthToken =
		options.clientKey === "clientA" ? defaults.syncRpcAuthTokenA : defaults.syncRpcAuthTokenB

	const synchrotronLayer =
		options.transportMode === "electric"
			? makeSynchrotronElectricClientLayer({
					rowIdentityByTable: {
						todos: (row) => row
					},
					config: {
						...(typeof syncRpcAuthToken === "string" ? { syncRpcAuthToken } : {}),
						syncRpcUrl,
						electricSyncUrl: defaults.electricUrl,
						pglite: {
							dataDir,
							debug: 0,
							relaxedDurability: true
						}
					},
					keyValueStoreLayer: makeLocalStorageKeyValueStoreLayer(kvPrefix)
				})
			: makeSynchrotronClientLayer({
					rowIdentityByTable: {
						todos: (row) => row
					},
					config: {
						...(typeof syncRpcAuthToken === "string" ? { syncRpcAuthToken } : {}),
						syncRpcUrl,
						electricSyncUrl: defaults.electricUrl,
						pglite: {
							dataDir,
							debug: 0,
							relaxedDurability: true
						}
					},
					keyValueStoreLayer: makeLocalStorageKeyValueStoreLayer(kvPrefix)
				})

	const clientLayer = TodoRepo.Default.pipe(
		Layer.provideMerge(TodoActions.Default),
		Layer.provideMerge(Layer.effectDiscard(setupClientDatabase)),
		Layer.provideMerge(synchrotronLayer),
		Layer.provideMerge(
			Layer.effectDiscard(
				Effect.logInfo("todoAppWeb.runtime.start", {
					clientKey: options.clientKey,
					transportMode: options.transportMode,
					userId: options.userId,
					projectId: defaults.projectId,
					hasSyncRpcAuthToken: typeof syncRpcAuthToken === "string" && syncRpcAuthToken.length > 0,
					syncRpcUrl,
					electricSyncUrl: defaults.electricUrl,
					pgliteDataDir: dataDir
				})
			)
		),
		Layer.provideMerge(
			Logger.replace(
				Logger.defaultLogger,
				Logger.prettyLoggerDefault.pipe(Logger.withLeveledConsole)
			)
		),
		Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Info)),
		Layer.provideMerge(
			makeOtelWebSdkLayer({
				defaultServiceName: defaults.otelServiceName,
				tracesEndpoint: defaults.otelTracesEndpoint,
				enabled: parseBooleanEnv(defaults.otelEnabled, true)
			})
		),
		Layer.provideMerge(
			makeOtelWebOtlpLoggerLayer({
				defaultServiceName: defaults.otelServiceName,
				logsEndpoint: defaults.otelLogsEndpoint,
				enabled: parseBooleanEnv(defaults.otelLogsEnabled, false)
			})
		),
		Layer.provideMerge(
			makeOtelWebOtlpMetricsLayer({
				defaultServiceName: defaults.otelServiceName,
				metricsEndpoint: defaults.otelMetricsEndpoint,
				enabled: parseBooleanEnv(defaults.otelMetricsEnabled, false)
			})
		),
		Layer.provideMerge(Layer.scope)
	)

	return clientLayer
}

export default function Index() {
	const [transportMode, setTransportMode] = useState<TransportMode>("rpc-poll")

	return (
		<Container size="4">
			<Flex direction="column" gap="4" py="5">
				<Flex align="center" justify="between" gap="3" wrap="wrap">
					<Flex align="center" gap="2">
						<img src={logo} width="28px" alt="logo" />
						<Heading size="5">Synchrotron To-Dos</Heading>
						<Badge color="violet" variant="soft">
							2 clients
						</Badge>
					</Flex>

					<Flex align="center" gap="2" wrap="wrap">
						<Text size="2" color="gray">
							Transport:
						</Text>
						<Button
							size="2"
							variant={transportMode === "rpc-poll" ? "solid" : "soft"}
							onClick={() => setTransportMode("rpc-poll")}
						>
							RPC (polling)
						</Button>
						<Button
							size="2"
							variant={transportMode === "electric" ? "solid" : "soft"}
							onClick={() => setTransportMode("electric")}
						>
							Electric (ingress)
						</Button>
					</Flex>
				</Flex>

				<Flex gap="4" direction={{ initial: "column", md: "row" }}>
					<ClientRuntimePanel
						clientKey="clientA"
						label="Client A"
						transportMode={transportMode}
						userId={defaults.userIdA}
						projectId={defaults.projectId}
					/>
					<ClientRuntimePanel
						clientKey="clientB"
						label="Client B"
						transportMode={transportMode}
						userId={defaults.userIdB}
						projectId={defaults.projectId}
					/>
				</Flex>
			</Flex>
		</Container>
	)
}

function ClientRuntimePanel(props: {
	readonly clientKey: string
	readonly label: string
	readonly transportMode: TransportMode
	readonly userId: string
	readonly projectId: string
}) {
	const [instance, setInstance] = useState(0)
	const [isResetting, setIsResetting] = useState(false)
	const pendingDisposeRef = useRef<null | {
		readonly runtime: ManagedRuntime.ManagedRuntime<any, any>
		readonly timerId: ReturnType<typeof setTimeout>
	}>(null)

	const runtime = useMemo(() => {
		const layer = makeClientLayer({
			clientKey: props.clientKey,
			transportMode: props.transportMode,
			userId: props.userId
		})
		return ManagedRuntime.make(layer)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.clientKey, props.transportMode, props.userId, instance])

	useEffect(() => {
		// React StrictMode runs effects + cleanups twice in development. Disposing the runtime
		// in the immediate cleanup will break the next effect pass. Defer disposal to the next tick
		// so the second pass can cancel it.
		const pending = pendingDisposeRef.current
		if (pending && pending.runtime === runtime) {
			clearTimeout(pending.timerId)
			pendingDisposeRef.current = null
		}

		return () => {
			const timerId = setTimeout(() => {
				console.info("todoAppWeb.runtime.dispose", {
					clientKey: props.clientKey,
					transportMode: props.transportMode
				})
				void runtime.dispose()
			}, 0)
			pendingDisposeRef.current = { runtime, timerId }
		}
	}, [runtime])

	const resetDb = useCallback(
		async (resetIdentity: boolean) => {
			if (isResetting) return
			setIsResetting(true)
			try {
				const dataDir = makeClientIdbDataDir(props.clientKey)
				const kvPrefix = makeKvPrefix(props.clientKey)

				// Unmount the UI that has live queries / intervals before disposing the runtime.
				// Otherwise some hooks may attempt to use the DB while we delete it.
				await new Promise<void>((resolve) => setTimeout(resolve, 0))
				await new Promise<void>((resolve) => setTimeout(resolve, 0))

				await runtime.runPromise(resetClientDatabase)

				await runtime.dispose()

				// Best-effort: deletion can be blocked even in a single-tab flow on some browsers.
				// The in-DB reset above guarantees the app state is cleared either way.
				await deleteIdbDatabase(dataDir)
				if (resetIdentity) {
					clearLocalStoragePrefix(kvPrefix)
				}
				setInstance((n) => n + 1)
			} catch (e) {
				console.error("Failed to reset client", e)
				alert(`Failed to reset ${props.label}: ${String(e)}`)
			} finally {
				setIsResetting(false)
			}
		},
		[isResetting, props.clientKey, props.label, runtime]
	)

	return (
		<RuntimeProvider runtime={runtime}>
			{isResetting ? (
				<Card>
					<Flex direction="column" gap="2">
						<Heading size="4">{props.label}</Heading>
						<Text size="2" color="gray">
							Resetting local state…
						</Text>
					</Flex>
				</Card>
			) : (
				<ClientPanel
					key={`${props.clientKey}-${instance}`}
					label={props.label}
					transportMode={props.transportMode}
					userId={props.userId}
					projectId={props.projectId}
					isResetting={isResetting}
					onResetDb={() => resetDb(false)}
					onResetIdentity={() => resetDb(true)}
				/>
			)}
		</RuntimeProvider>
	)
}

function ClientPanel(props: {
	readonly label: string
	readonly transportMode: TransportMode
	readonly userId: string
	readonly projectId: string
	readonly isResetting: boolean
	readonly onResetDb: () => void
	readonly onResetIdentity: () => void
}) {
	const runtime = useRuntime()

	const { todos, isLoading } = useReactiveTodos()
	const [newTodoText, setNewTodoText] = useState("")
	const [offline, setOffline] = useState(false)
	const offlineRef = useRef(false)
	const [isSyncing, setIsSyncing] = useState(false)
	const syncingRef = useRef(false)
	const offlineSupported = props.transportMode === "rpc-poll"

	useEffect(() => {
		if (!offlineSupported && offline) {
			offlineRef.current = false
			setOffline(false)
		}
	}, [offline, offlineSupported])

	useEffect(() => {
		offlineRef.current = offline
	}, [offline])

	const toggleOffline = useCallback(() => {
		setOffline((prev) => {
			const next = !prev
			offlineRef.current = next
			return next
		})
	}, [])

	const runSync = useCallback(() => {
		if (offlineRef.current) return Promise.resolve()
		if (syncingRef.current) return Promise.resolve()
		syncingRef.current = true
		setIsSyncing(true)

		const effect = Effect.gen(function* () {
			const syncService = yield* SyncService
			yield* syncService.performSync()
		})

		return runtime
			.runPromise(effect)
			.catch((e) => {
				if (String(e).includes("ManagedRuntime disposed")) return
				console.warn(`${props.label}: sync failed`, e)
			})
			.finally(() => {
				syncingRef.current = false
				setIsSyncing(false)
			})
	}, [props.label, runtime])

	useEffect(() => {
		if (props.transportMode !== "rpc-poll") return
		if (offline) return
		const id = setInterval(() => void runSync(), 4000)
		return () => clearInterval(id)
	}, [props.transportMode, offline, runSync])

	const handleAddTodo = useCallback(() => {
		const text = newTodoText.trim()
		if (!text) return

		const createEffect = Effect.gen(function* () {
			const syncService = yield* SyncService
			const actions = yield* TodoActions
			const timestamp = yield* Clock.currentTimeMillis

			const action = actions.createTodoAction({
				text,
				project_id: props.projectId,
				created_by: props.userId,
				timestamp
			})

			yield* syncService.executeAction(action)
		})

		runtime
			.runPromise(createEffect)
			.then(() => setNewTodoText(""))
			.then(() => runSync())
			.catch((err: ActionExecutionError | Error) => console.error("Failed to create todo:", err))
	}, [newTodoText, props.projectId, props.userId, runtime, runSync])

	const handleToggleTodo = useCallback(
		(todo: Todo) => {
			const toggleEffect = Effect.gen(function* () {
				const syncService = yield* SyncService
				const actions = yield* TodoActions
				const timestamp = yield* Clock.currentTimeMillis

				const action = actions.toggleTodoCompletionAction({
					id: todo.id,
					timestamp
				})
				yield* syncService.executeAction(action)
			})

			runtime
				.runPromise(toggleEffect)
				.then(() => runSync())
				.catch((err: ActionExecutionError | Error) => console.error("Failed to toggle todo:", err))
		},
		[runtime, runSync]
	)

	const handleDeleteTodo = useCallback(
		(todoId: string) => {
			const deleteEffect = Effect.gen(function* () {
				const syncService = yield* SyncService
				const actions = yield* TodoActions
				const timestamp = yield* Clock.currentTimeMillis

				const action = actions.deleteTodoAction({
					id: todoId,
					timestamp
				})
				yield* syncService.executeAction(action)
			})

			runtime
				.runPromise(deleteEffect)
				.then(() => runSync())
				.catch((err: ActionExecutionError | Error) => console.error("Failed to delete todo:", err))
		},
		[runtime, runSync]
	)

	return (
		<Card>
			<Flex direction="column" gap="3">
				<Flex align="center" justify="between" gap="3" wrap="wrap">
					<Heading size="4">{props.label}</Heading>
					<Flex align="center" gap="2" wrap="wrap">
						<Badge color="gray" variant="soft">
							User: {props.userId}
						</Badge>
						<Badge color="gray" variant="soft">
							Project: {props.projectId}
						</Badge>
						<Badge color={offline ? "red" : "green"} variant="soft">
							{offline ? "Offline" : "Online"}
						</Badge>
						<Button size="2" variant="soft" disabled={!offlineSupported} onClick={toggleOffline}>
							{offlineSupported ? (offline ? "Go online" : "Go offline") : "Offline (RPC only)"}
						</Button>
						<Button size="2" onClick={() => void runSync()} disabled={offline || isSyncing}>
							{isSyncing ? "Syncing…" : "Sync now"}
						</Button>
					</Flex>
				</Flex>

				<Separator size="4" />

				<Flex direction="column" gap="2">
					{isLoading ? (
						<Text color="gray">Loading todos…</Text>
					) : todos.length === 0 ? (
						<Text color="gray">No to-dos yet.</Text>
					) : (
						todos.map((todo) => (
							<Card
								key={todo.id}
								onClick={() => handleToggleTodo(todo)}
								style={{ cursor: "pointer" }}
							>
								<Flex gap="2" align="center" justify="between">
									<Text as="label">
										<Flex gap="2" align="center">
											<Checkbox checked={!!todo.completed} />
											{todo.text}
										</Flex>
									</Text>
									<Button
										onClick={(e) => {
											e.stopPropagation()
											handleDeleteTodo(todo.id)
										}}
										variant="ghost"
										ml="auto"
										style={{ cursor: "pointer" }}
									>
										Delete
									</Button>
								</Flex>
							</Card>
						))
					)}
				</Flex>

				<Flex direction="row" gap="2">
					<TextField.Root
						value={newTodoText}
						onChange={(e: ChangeEvent<HTMLInputElement>) => setNewTodoText(e.target.value)}
						type="text"
						name="todo"
						placeholder="New todo"
						style={{ width: "100%" }}
					/>
					<Button onClick={handleAddTodo} disabled={!newTodoText.trim()}>
						Add
					</Button>
				</Flex>

				<Separator size="4" />

				<ClientDebugPanel transportMode={props.transportMode} />

				<Flex gap="2" wrap="wrap">
					<Button
						size="1"
						variant="soft"
						color="red"
						disabled={props.isResetting}
						onClick={() => {
							if (
								!confirm(
									`Reset local DB for ${props.label}?\n\nThis keeps the client identity. If the backend still has action history, the next sync will restore this client by re-fetching and replaying its own history.\n\nUse “Reset DB + identity” if you want a brand new client id.`
								)
							)
								return
							props.onResetDb()
						}}
					>
						Reset DB (keep id)
					</Button>
					<Button
						size="1"
						variant="soft"
						color="red"
						disabled={props.isResetting}
						onClick={() => {
							if (!confirm(`Reset DB + identity for ${props.label}?`)) return
							props.onResetIdentity()
						}}
					>
						Reset DB + identity
					</Button>
				</Flex>
			</Flex>
		</Card>
	)
}

function ClientDebugPanel(props: { readonly transportMode: TransportMode }) {
	const runtime = useRuntime()
	const [state, setState] = useState<null | {
		readonly clientId: string
		readonly lastSeenServerIngestId: number
		readonly electricFullySynced: boolean | null
		readonly actionRecords: {
			readonly total: number
			readonly unsynced: number
			readonly synced: number
			readonly syncedButUnapplied: number
		}
		readonly actionModifiedRows: {
			readonly total: number
			readonly unsynced: number
		}
	}>(null)

	useEffect(() => {
		let cancelled = false
		const load = () => {
			const effect = Effect.gen(function* () {
				const clockState = yield* ClientClockState
				// Ensure client_sync_status exists
				const lastSeenServerIngestId = yield* clockState.getLastSeenServerIngestId
				const clientId = yield* clockState.getClientId
				const sql = yield* SqlClient.SqlClient
				const electricFullySynced =
					props.transportMode === "electric"
						? yield* (yield* ElectricSyncService).isFullySynced()
						: null

				const readCount = (
					q: Effect.Effect<ReadonlyArray<{ readonly count: number | string }>, any, any>
				) =>
					q.pipe(
						Effect.map((rows) => {
							const raw = rows[0]?.count ?? 0
							return typeof raw === "number" ? raw : Number(raw)
						})
					)

				const actionTotal = yield* readCount(
					sql<{
						readonly count: number | string
					}>`SELECT count(*)::int as count FROM action_records`
				)
				const actionUnsynced = yield* readCount(
					sql<{
						readonly count: number | string
					}>`SELECT count(*)::int as count FROM action_records WHERE synced = 0`
				)
				const actionSynced = yield* readCount(
					sql<{
						readonly count: number | string
					}>`SELECT count(*)::int as count FROM action_records WHERE synced = 1`
				)
				const syncedButUnapplied = yield* readCount(sql<{ readonly count: number | string }>`
						SELECT count(*)::int as count
						FROM action_records ar
						LEFT JOIN local_applied_action_ids la ON ar.id = la.action_record_id
						WHERE la.action_record_id IS NULL
						AND ar.synced = 1
					`)

				const amrTotal = yield* readCount(
					sql<{
						readonly count: number | string
					}>`SELECT count(*)::int as count FROM action_modified_rows`
				)
				const amrUnsynced = yield* readCount(sql<{ readonly count: number | string }>`
					SELECT count(*)::int as count
					FROM action_modified_rows amr
					JOIN action_records ar ON amr.action_record_id = ar.id
					WHERE ar.synced = 0
				`)

				return {
					clientId: String(clientId),
					lastSeenServerIngestId,
					electricFullySynced,
					actionRecords: {
						total: actionTotal,
						unsynced: actionUnsynced,
						synced: actionSynced,
						syncedButUnapplied
					},
					actionModifiedRows: {
						total: amrTotal,
						unsynced: amrUnsynced
					}
				} as const
			})

			return runtime
				.runPromise(effect)
				.then((s) => {
					if (cancelled) return
					setState(s)
				})
				.catch((e) => {
					if (cancelled) return
					if (String(e).includes("ManagedRuntime disposed")) return
					console.warn("Failed to load debug state", e)
				})
		}

		load()
		const id = setInterval(load, 1000)
		return () => {
			cancelled = true
			clearInterval(id)
		}
	}, [runtime])

	if (!state) {
		return (
			<Box>
				<Text size="2" color="gray">
					Loading debug state…
				</Text>
			</Box>
		)
	}

	return (
		<Box>
			<Text size="2" color="gray">
				Transport: {props.transportMode}
			</Text>
			{props.transportMode === "electric" ? (
				<Text size="2" color="gray">
					electric fully synced: {state.electricFullySynced === true ? "yes" : "no"}
				</Text>
			) : null}
			<Text size="2" color="gray">
				clientId: {state.clientId}
			</Text>
			<Text size="2" color="gray">
				last_seen_server_ingest_id: {state.lastSeenServerIngestId}
			</Text>
			<Text size="2" color="gray">
				action_records: total {state.actionRecords.total} · unsynced {state.actionRecords.unsynced}{" "}
				· synced {state.actionRecords.synced} · synced-but-unapplied{" "}
				{state.actionRecords.syncedButUnapplied}
			</Text>
			<Text size="2" color="gray">
				action_modified_rows: total {state.actionModifiedRows.total} · unsynced{" "}
				{state.actionModifiedRows.unsynced}
			</Text>
		</Box>
	)
}
