import { makeSynchrotronSqliteReactNativeClientLayer } from "@synchrotron/sync-client/react-native"
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

const defaultSyncRpcUrl = Platform.select({
	android: "http://localhost:3010/rpc",
	default: "http://localhost:3010/rpc"
})

const syncRpcUrl =
	process.env.EXPO_PUBLIC_SYNC_RPC_URL ?? defaultSyncRpcUrl ?? "http://localhost:3010/rpc"

const AppLive = TodoRepo.Default.pipe(
	Layer.provideMerge(TodoActions.Default),
	Layer.provideMerge(Layer.effectDiscard(setupClientDatabase)),
	Layer.provideMerge(
		makeSynchrotronSqliteReactNativeClientLayer(
			{ filename: "todo-app.db" },
			{
				syncRpcUrl
			}
		)
	),
	Layer.provideMerge(
		Logger.replace(Logger.defaultLogger, Logger.prettyLoggerDefault.pipe(Logger.withLeveledConsole))
	),
	Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Info)),
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
