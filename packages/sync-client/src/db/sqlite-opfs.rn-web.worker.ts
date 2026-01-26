/// <reference lib="webworker" />

// React Native Web / Metro worker entry for sqlite-wasm OPFS persistence.

const g = globalThis as any

// Expo's web Babel preset transforms `import.meta` into `globalThis.__ExpoImportMetaRegistry`.
// In Web Workers, that registry isn't automatically initialized, and libraries like `@effect/wa-sqlite`
// read `import.meta.url` at module evaluation time.
if (typeof g.__ExpoImportMetaRegistry !== "object" || g.__ExpoImportMetaRegistry === null) {
	g.__ExpoImportMetaRegistry = {
		get url() {
			try {
				if (typeof self !== "undefined" && typeof self.location?.href === "string") {
					return self.location.href
				}
			} catch {
				// ignore
			}
			return ""
		}
	}
}

const wasmUrl = (() => {
	try {
		if (typeof self !== "undefined" && typeof self.location?.origin === "string") {
			return `${self.location.origin}/wa-sqlite.wasm`
		}
	} catch {
		// ignore
	}

	return "/wa-sqlite.wasm"
})()

g.__EFFECT_WA_SQLITE_WASM_URL__ = wasmUrl

const dbName =
	typeof self !== "undefined" && typeof self.name === "string" && self.name.length > 0
		? self.name
		: "synchrotron.db"

const assertOpfsWorkerSupport = (): void => {
	const storage = (navigator as any)?.storage
	if (!storage || typeof storage.getDirectory !== "function") {
		throw new Error("OPFS is not available (navigator.storage.getDirectory is missing)")
	}

	const fileHandle = (globalThis as any).FileSystemFileHandle
	if (typeof fileHandle?.prototype?.createSyncAccessHandle !== "function") {
		throw new Error(
			"FileSystemSyncAccessHandle is not available (FileSystemFileHandle.createSyncAccessHandle is missing)"
		)
	}
}

// Metro doesn't currently support `import()` well inside worker bundles (it can lead to
// "Requiring unknown module" errors at runtime). Use `require` so everything is bundled
// into the worker script deterministically.
declare const require: (id: string) => any

const start = async () => {
	if (typeof require !== "function") {
		throw new Error("sqlite-opfs.rn-web.worker requires Metro (global require is missing)")
	}

	const Effect = require("effect/Effect") as typeof import("effect/Effect")
	const OpfsWorker =
		require("@effect/sql-sqlite-wasm/OpfsWorker") as typeof import("@effect/sql-sqlite-wasm/OpfsWorker")

	await Effect.runPromise(
		Effect.sync(() => assertOpfsWorkerSupport()).pipe(
			Effect.zipRight(OpfsWorker.run({ port: self, dbName }))
		)
	)
}

start().catch((cause) => {
	const message = cause instanceof Error ? cause.message : String(cause)
	console.error("sqlite-opfs.rn-web.worker failed to start", cause)

	try {
		self.postMessage(["ready", message, undefined])
	} catch {
		// ignore
	}

	throw cause
})
