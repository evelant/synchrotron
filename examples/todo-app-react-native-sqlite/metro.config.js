// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config")
const fs = require("node:fs")

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname, {
	annotateReactComponents: true,
	resolver: {
		// resolverMainFields: ["react-native", "browser", "main"],
		unstable_enableSymlinks: true,
		unstable_enablePackageExports: true,
		useWatchman: false
	}
})

// Ensure Metro treats `.wasm` as an asset on web (required by `@effect/sql-sqlite-wasm` / `@effect/wa-sqlite`).
config.resolver.assetExts = Array.from(new Set([...(config.resolver.assetExts ?? []), "wasm"]))

// Serve `wa-sqlite.wasm` with a stable URL + correct MIME type.
// (Also serves `/assets/.../wa-sqlite.wasm` because some loaders resolve relative to scriptDirectory.)
// Additionally, set COEP/COOP headers (recommended by Expo for sqlite-wasm style workloads on web).
config.server = config.server ?? {}
config.server.enhanceMiddleware = (middleware) => {
	const wasmByBasename = new Map([
		["wa-sqlite.wasm", require.resolve("@effect/wa-sqlite/dist/wa-sqlite.wasm")],
		["wa-sqlite-async.wasm", require.resolve("@effect/wa-sqlite/dist/wa-sqlite-async.wasm")],
		["wa-sqlite-jspi.wasm", require.resolve("@effect/wa-sqlite/dist/wa-sqlite-jspi.wasm")]
	])

	return (req, res, next) => {
		res.setHeader("Cross-Origin-Embedder-Policy", "credentialless")
		res.setHeader("Cross-Origin-Opener-Policy", "same-origin")

		const url = typeof req.url === "string" ? req.url : ""
		const pathname = url.split("?")[0]
		const basename = pathname.split("/").at(-1)
		const filename = basename ? wasmByBasename.get(basename) : undefined

		if (filename) {
			res.statusCode = 200
			res.setHeader("Content-Type", "application/wasm")
			res.setHeader("Cache-Control", "no-store")
			fs.createReadStream(filename).pipe(res)
			return
		}

		return middleware(req, res, next)
	}
}
config.transformer.getTransformOptions = async () => ({
	transform: {
		experimentalImportSupport: true
	}
})
module.exports = config
