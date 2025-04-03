import { resolve } from "path"
import { defineConfig } from "vite"

export default defineConfig({
	build: {
		lib: {
			// Point to the entry file for the library
			entry: resolve(__dirname, "src/index.ts"),
			// The name for the global variable (if using UMD/IIFE formats, not strictly needed for ES)
			name: "@synchrotron/sync-core",
			// The base name for the output file(s)
			fileName: "index",
			// Specify the output formats (ES module in this case)
			formats: ["es"]
		},
		sourcemap: true,
		// Ensure the output is compatible with modern environments
		target: "esnext",
		// Optional: Specify the output directory (defaults to 'dist')
		// outDir: 'dist'
	},
	resolve: {
		alias: {
			// Create an alias for easier imports within the package
			"@synchrotron/sync-core": resolve(__dirname, "src")
		}
	}
})