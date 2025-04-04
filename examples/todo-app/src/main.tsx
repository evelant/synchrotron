import React, { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import ReactDOM from "react-dom/client"
import { createBrowserRouter, RouterProvider } from "react-router"
import ErrorPage from "./error-page"

import { Theme } from "@radix-ui/themes"
import "@fontsource/alegreya-sans/latin.css"
import { ManagedRuntime, type Context, Layer } from "effect" // Import Layer
import { PgLiteClientLive, SynchrotronClientLive } from "@synchrotron/sync-client"
import "@radix-ui/themes/styles.css"
import "./style.css"
import Root from "./routes/root"

import Index from "./routes/index"
import { TodoRepo } from "./db/repositories" // Import app-specific layers
import { TodoActions } from "./actions"

// Compose the final application layer including client and app-specific services
const AppLive = SynchrotronClientLive.pipe(
	Layer.provideMerge(TodoRepo.Default),
	Layer.provideMerge(TodoActions.Default),
	Layer.provideMerge(PgLiteClientLive)
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

export function useService<T extends AppServices>(tag: Context.Tag<T, T>): T | undefined {
	const runtime = useRuntime()
	const [svc, setSvc] = useState<T | undefined>(undefined)
	useEffect(() => {
		if (runtime) {
			runtime
				.runPromise(tag)
				.then((s) => {
					setSvc(s)
				})
				.catch((e) => console.error(`useService error getting service`, e))
		}

		return () => {
			setSvc(undefined)
		}
	}, [runtime])

	return svc
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
