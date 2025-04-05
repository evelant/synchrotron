import { resolve } from "path"
import { defineConfig, mergeConfig } from "vite"
import shared from "../../vite.shared.ts"

export default mergeConfig(
	shared,
	defineConfig({
		build: {
			lib: {
				entry: resolve(__dirname, "src/index.ts"),
				name: "@synchrotron/sync-server",
				fileName: "index",
				formats: ["es"]
			},
			sourcemap: true,
			ssr: true,
			target: "esnext",
			rollupOptions: {
				external: [
					"node:util",
					"node:buffer",
					"node:stream",
					"node:net",
					"node:url",
					"node:fs",
					"node:path",
					"perf_hooks",
					"node:net",
					"node:tls",
					"node:crypto"
				]
			}
		}
	})
)
