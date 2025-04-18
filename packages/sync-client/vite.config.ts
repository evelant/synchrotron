import { resolve } from "path"
import { defineConfig, mergeConfig } from "vite"
import shared from "../../vite.shared.ts"

export default mergeConfig(
	shared,
	defineConfig({
		build: {
			lib: {
				entry: resolve(__dirname, "src/index.ts"),
				name: "@synchrotron/sync-client",
				fileName: "index",
				formats: ["es"]
			},
			sourcemap: true,
			target: "esnext"
		}
	})
)
