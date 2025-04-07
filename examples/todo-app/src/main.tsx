import React, {
	createContext,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode
} from "react"
import ReactDOM from "react-dom/client"
import { createBrowserRouter, RouterProvider } from "react-router"
import ErrorPage from "./error-page"

import "@fontsource/alegreya-sans/latin.css"
import { Theme } from "@radix-ui/themes"
import "@radix-ui/themes/styles.css"
import { makeSynchrotronClientLayer } from "@synchrotron/sync-client"
import { Effect, Layer, Logger, LogLevel, ManagedRuntime, type Context } from "effect" // Import Layer
import Root from "./routes/root"
import "./style.css"

import { setupDatabase } from "examples/todo-app/src/db/setup"
import { TodoActions } from "./actions"
import { TodoRepo } from "./db/repositories" // Import app-specific layers
import Index from "./routes/index"

// App-specific synchrotron configuration
const syncConfig = {
	electricSyncUrl: "http://localhost:5133",
	pglite: {
		dataDir: "idb://todo-app",
		debug: 0, //1, //import.meta.env.DEV ? 1 : 0,
		relaxedDurability: true
	}
}

// Create the application runtime layer
// The proper order matters for dependency resolution
// Start with TodoRepo and other app services that require Synchrotron
const AppLive = TodoRepo.Default.pipe(
	Layer.provideMerge(TodoActions.Default),
	Layer.provideMerge(Layer.effectDiscard(setupDatabase)),
	Layer.provideMerge(makeSynchrotronClientLayer(syncConfig)),
	Layer.provideMerge(Layer.effectDiscard(Effect.logInfo(`creating layers`))),
	Layer.provideMerge(
		Logger.replace(Logger.defaultLogger, Logger.prettyLoggerDefault.pipe(Logger.withLeveledConsole))
	),
	Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Trace))
)

const runtime = ManagedRuntime.make(AppLive)
export type AppServices = ManagedRuntime.ManagedRuntime.Context<typeof runtime>
// 5. Define Runtime Type and Context
const RuntimeContext = createContext<typeof runtime | null>(null)

// 6. Hook to use Runtime
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
		if (runtime) {
			runtime
				.runPromise(tag)
				.then((s) => {
					console.log(`useService got service`, tag, s)
					svc.current = s
					set(true)
				})
				.catch((e) => console.error(`useService error getting service`, e))
		}
	}, [runtime, tag])

	return svc.current
}

// 7. Provider Component
const RuntimeProvider = ({ children }: { children: ReactNode }) => {
	// ManagedRuntime handles its own lifecycle, just provide the instance
	return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>
}

// 8. Define Router
const router = createBrowserRouter([
	{
		path: `/`,
		element: <Root />,
		errorElement: <ErrorPage />,
		children: [
			{
				index: true,
				element: <Index />
			}
		]
	}
])

// 9. Render Application
const rootElement = document.getElementById("root")
if (!rootElement) {
	throw new Error("Root element not found")
}

ReactDOM.createRoot(rootElement).render(
	<React.StrictMode>
		<Theme appearance="dark" accentColor="violet" panelBackground="solid">
			<RuntimeProvider>
				<RouterProvider router={router} />
			</RuntimeProvider>
		</Theme>
	</React.StrictMode>
)
