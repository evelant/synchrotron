import { resolve } from "path"
import { defineConfig } from "vite"

export default defineConfig({
	build: {
		lib: {
			entry: resolve(__dirname, "src/index.ts"),
			name: "@synchrotron/sync-core",
			fileName: "index",
			formats: ["es"]
		},
		sourcemap: true,
		target: "esnext",
	},
	resolve: {
		alias: {
			"@synchrotron/sync-core": resolve(__dirname, "src")
		}
	}
})