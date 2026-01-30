import { makeSynchrotronSqliteReactNativeClientLayer } from "@synchrotron/sync-client/react-native"
import {
	makeOtelWebOtlpLoggerLayer,
	makeOtelWebOtlpMetricsLayer,
	makeOtelWebSdkLayer
} from "@synchrotron/observability/web"
import { Effect, Layer, Logger, LogLevel, ManagedRuntime, type Context } from "effect"
import React, {
	createContext,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode
} from "react"
import { Platform } from "react-native"
import { TodoActions } from "./actions"
import { TodoRepo } from "./db/repositories"
import { setupClientDatabase } from "./db/setup"

export const sqliteFilenameStorageKey = "synchrotron.todoApp.sqliteFilename"

const defaultSqliteFilename = "todo-app.db"

const resolveSqliteFilename = () => {
	if (Platform.OS !== "web") return defaultSqliteFilename
	try {
		const existing = window.localStorage.getItem(sqliteFilenameStorageKey)
		if (typeof existing === "string" && existing.length > 0) return existing
		window.localStorage.setItem(sqliteFilenameStorageKey, defaultSqliteFilename)
	} catch {
		// ignore
	}
	return defaultSqliteFilename
}

export const sqliteFilename = resolveSqliteFilename()

const defaultSyncRpcUrl = Platform.select({
	android: "http://localhost:3010/rpc",
	default: "http://localhost:3010/rpc"
})

const syncRpcUrl =
	process.env.EXPO_PUBLIC_SYNC_RPC_URL ?? defaultSyncRpcUrl ?? "http://localhost:3010/rpc"

const syncRpcAuthToken = process.env.EXPO_PUBLIC_SYNC_RPC_AUTH_TOKEN

const userId = process.env.EXPO_PUBLIC_SYNC_USER_ID ?? "user1"

const otelEnabled = process.env.EXPO_PUBLIC_OTEL_ENABLED ?? "true"
const otelServiceName = process.env.EXPO_PUBLIC_OTEL_SERVICE_NAME ?? "synchrotron-example-react-native"
const otelTracesEndpoint =
	process.env.EXPO_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? "http://localhost:4318/v1/traces"

const otelLogsEnabled = process.env.EXPO_PUBLIC_OTEL_LOGS_ENABLED ?? "false"
const otelLogsEndpoint =
	process.env.EXPO_PUBLIC_OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? "http://localhost:4318/v1/logs"

const otelMetricsEnabled = process.env.EXPO_PUBLIC_OTEL_METRICS_ENABLED ?? "false"
const otelMetricsEndpoint =
	process.env.EXPO_PUBLIC_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? "http://localhost:4318/v1/metrics"

const parseBooleanEnv = (value: string, fallback: boolean) => {
	const normalized = value.trim().toLowerCase()
	if (normalized === "true" || normalized === "1" || normalized === "yes") return true
	if (normalized === "false" || normalized === "0" || normalized === "no") return false
	return fallback
}

const AppLive = TodoRepo.Default.pipe(
	Layer.provideMerge(
		Layer.effectDiscard(
			Effect.logInfo("todoApp.runtime.start", {
				platform: Platform.OS,
				userId,
				hasSyncRpcAuthToken: typeof syncRpcAuthToken === "string" && syncRpcAuthToken.length > 0,
				syncRpcUrl,
				sqliteFilename
			})
		)
	),
	Layer.provideMerge(TodoActions.Default),
	Layer.provideMerge(Layer.effectDiscard(setupClientDatabase)),
	Layer.provideMerge(
		makeSynchrotronSqliteReactNativeClientLayer(
			{ filename: sqliteFilename },
			{
				syncRpcUrl,
				syncRpcAuthToken
			}
		)
	),
	Layer.provideMerge(
		Logger.replace(Logger.defaultLogger, Logger.prettyLoggerDefault.pipe(Logger.withLeveledConsole))
	),
	Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Trace)),
	Layer.provideMerge(
		makeOtelWebSdkLayer({
			defaultServiceName: otelServiceName,
			tracesEndpoint: otelTracesEndpoint,
			enabled: parseBooleanEnv(otelEnabled, true)
		})
	),
	Layer.provideMerge(
		makeOtelWebOtlpLoggerLayer({
			defaultServiceName: otelServiceName,
			logsEndpoint: otelLogsEndpoint,
			enabled: parseBooleanEnv(otelLogsEnabled, false)
		})
	),
	Layer.provideMerge(
		makeOtelWebOtlpMetricsLayer({
			defaultServiceName: otelServiceName,
			metricsEndpoint: otelMetricsEndpoint,
			enabled: parseBooleanEnv(otelMetricsEnabled, false)
		})
	),
	Layer.provideMerge(Layer.scope)
)

const runtime = ManagedRuntime.make(AppLive)

export type AppServices = ManagedRuntime.ManagedRuntime.Context<typeof runtime>

const RuntimeContext = createContext<typeof runtime | null>(null)

export const RuntimeProvider = ({ children }: { children: ReactNode }) => (
	<RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>
)

export const useRuntime = () => {
	const ctx = useContext(RuntimeContext)
	if (!ctx) {
		throw new Error("useRuntime must be used within a RuntimeProvider")
	}
	return ctx
}

export function useService<T extends AppServices, U>(tag: Context.Tag<T, U>): U | undefined {
	const runtime = useRuntime()
	const svc = useRef<U | undefined>(undefined)
	const [_, set] = useState(false)

	useEffect(() => {
		runtime
			.runPromise(tag)
			.then((s) => {
				svc.current = s
				set(true)
			})
			.catch((e) => console.error(`useService error getting service`, e))
	}, [runtime, tag])

	return svc.current
}
