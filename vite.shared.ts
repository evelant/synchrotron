import path from "path" // Use default import for path
import wasm from "vite-plugin-wasm"
import tsconfigPaths from "vite-tsconfig-paths"
import type { ViteUserConfig } from "vitest/config"

const config: ViteUserConfig = {
	plugins: [tsconfigPaths(), wasm()],
	assetsInclude: ["**/*.sql"],
	build: {
		rollupOptions: {
			// external: [],
			preserveSymlinks: false // Align with resolve.preserveSymlinks for consistency
		}
	},
	optimizeDeps: {
		exclude: [
			"@electric-sql/pglite"
			// 	"@effect/sync-client",
			// 	"@effect/sync-core",
			// 	"@effect/sql-pglite",
			// 	"@effect/platform-node",
			// 	"@effect/experimental" // Exclude experimental packages too
			// ],
			// include: [
			// 	// Base packages
			// 	"react-router-dom",
			// 	"scheduler",
			// 	"classnames",
			// 	"@radix-ui/themes",
			// 	"radix-ui",
			// 	"effect",
			// 	"@effect/schema",
			// 	"@effect/sql",
			// 	"@effect/platform",
			// 	// Specific failing internal/deep paths from logs
			// 	"radix-ui/internal", // Explicitly include internal
			// 	"@opentelemetry/semantic-conventions", // Add specific failing externals
			// 	"turbo-stream",
			// 	"cookie",
			// 	"set-cookie-parser",
			// 	"msgpackr",
			// 	"multipasta",
			// 	"find-my-way-ts",
			// 	"fast-check",
			// 	"@electric-sql/experimental" // Include this specific one
		]
	},

	server: {
		fs: {
			allow: ["../.."]
		}
	},

	resolve: {
		preserveSymlinks: false
	}
}

export default config
