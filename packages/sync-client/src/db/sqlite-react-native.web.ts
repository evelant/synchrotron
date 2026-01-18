import { SqliteClient } from "@effect/sql-sqlite-wasm"
import { Effect } from "effect"
import type { SqliteReactNativeClientConfig } from "./sqlite-react-native-config"

export type { SqliteReactNativeClientConfig } from "./sqlite-react-native-config"

const waSqliteWasmUrl = (): string => {
	if (typeof window !== "undefined" && typeof window.location?.origin === "string") {
		return `${window.location.origin}/wa-sqlite.wasm`
	}

	return "/wa-sqlite.wasm"
}

const setWaSqliteWasmUrl = () => {
	if (typeof globalThis === "undefined") return
	const g = globalThis as any
	if (typeof g.__EFFECT_WA_SQLITE_WASM_URL__ === "string" && g.__EFFECT_WA_SQLITE_WASM_URL__.length > 0) {
		return
	}

	// RN Web uses `@effect/sql-sqlite-wasm` / `@effect/wa-sqlite`, which fetches a `.wasm` file at runtime.
	// We rely on the host app serving `wa-sqlite.wasm` at `/wa-sqlite.wasm` (e.g. from a `public/` folder).
	g.__EFFECT_WA_SQLITE_WASM_URL__ = waSqliteWasmUrl()
}

setWaSqliteWasmUrl()

const assertOpfsWorkerSupport = (): void => {
	if (typeof window === "undefined") {
		throw new Error("sqlite-wasm OPFS requires a browser environment")
	}
	if (typeof Worker === "undefined") {
		throw new Error("sqlite-wasm OPFS requires Web Worker support (global Worker is missing)")
	}

	const storage = (navigator as any)?.storage
	if (!storage || typeof storage.getDirectory !== "function") {
		throw new Error(
			"sqlite-wasm OPFS requires the Origin Private File System API (navigator.storage.getDirectory is missing)"
		)
	}
}

const makeOpfsWorker = (dbName: string) =>
	Effect.acquireRelease(
		Effect.gen(function* () {
			yield* Effect.logInfo("db.sqlite.opfsWorker.acquire.start", { dbName })
			yield* Effect.sync(() => assertOpfsWorkerSupport())
			return new Worker(new URL("./sqlite-opfs.rn-web.worker", window.location.href), { name: dbName })
		}),
		(worker) =>
			Effect.gen(function* () {
				yield* Effect.logInfo("db.sqlite.opfsWorker.release", { dbName })
				yield* Effect.sync(() => worker.terminate())
			})
	)

/**
 * React Native Web implementation of the "react-native sqlite" layer.
 *
 * Uses sqlite-wasm with OPFS persistence via `@effect/sql-sqlite-wasm`'s OpfsWorker.
 */
export const makeSqliteReactNativeClientLayer = (config: SqliteReactNativeClientConfig) =>
	SqliteClient.layer({
		worker: makeOpfsWorker(config.filename),
		...(config.spanAttributes ? { spanAttributes: config.spanAttributes } : {}),
		...(config.transformResultNames ? { transformResultNames: config.transformResultNames } : {}),
		...(config.transformQueryNames ? { transformQueryNames: config.transformQueryNames } : {})
	})
