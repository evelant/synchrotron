import { ManagedRuntime, type Context } from "effect"
import React, {
	createContext,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode
} from "react"

export type AppRuntime = ManagedRuntime.ManagedRuntime<any, any>

const RuntimeContext = createContext<AppRuntime | null>(null)

export const RuntimeProvider = ({ runtime, children }: { runtime: AppRuntime; children: ReactNode }) => {
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
	const [_, set] = useState(false)

	useEffect(() => {
		let cancelled = false

		runtime
			.runPromise(tag)
			.then((s) => {
				if (cancelled) return
				svc.current = s
				set(true)
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
