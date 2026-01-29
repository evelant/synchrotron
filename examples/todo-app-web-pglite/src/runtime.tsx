import { ManagedRuntime, type Context } from "effect"
import React, {
	createContext,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode
} from "react"

type AppRuntime = ManagedRuntime.ManagedRuntime<any, any>

const RuntimeContext = createContext<AppRuntime | null>(null)

export const RuntimeProvider = ({
	runtime,
	children
}: {
	runtime: AppRuntime
	children: ReactNode
}) => {
	return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>
}

export const useRuntime = (): AppRuntime => {
	const runtime = useContext(RuntimeContext)
	if (!runtime) {
		throw new Error("useRuntime must be used within a RuntimeProvider")
	}
	return runtime
}

export function useService<U>(tag: Context.Tag<any, U>): U | undefined {
	const runtime = useRuntime()
	const svc = useRef<U | undefined>(undefined)
	const last = useRef<{
		readonly runtime: AppRuntime
		readonly tag: Context.Tag<any, U>
	} | null>(null)
	const [_, forceRender] = useState(0)

	// If the runtime/tag changes, do not keep returning a service from the previous runtime.
	// This prevents hooks from holding onto resources (e.g. PGlite live queries) after the
	// old runtime is disposed.
	if (last.current === null || last.current.runtime !== runtime || last.current.tag !== tag) {
		last.current = { runtime, tag }
		svc.current = undefined
	}

	useEffect(() => {
		let cancelled = false

		runtime
			.runPromise(tag)
			.then((s) => {
				if (cancelled) return
				svc.current = s
				forceRender((n) => n + 1)
			})
			.catch((e) => {
				if (cancelled) return
				if (String(e).includes("ManagedRuntime disposed")) return
				console.error(`useService error getting service`, e)
			})

		return () => {
			cancelled = true
		}
	}, [runtime, tag])

	return svc.current
}
