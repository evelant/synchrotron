import wasm from "vite-plugin-wasm"
import { type ViteUserConfig } from "vitest/config"

const config: ViteUserConfig = {
	plugins: [wasm()],
	test: {
		include: ["test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
		setupFiles: ["./vitest-setup.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			include: ["src/**/*.{js,ts}"]
		}
	},
	resolve: {
		alias: {
			"@effect/sql-pglite": new URL("./src", import.meta.url).pathname
		}
	}
}

export default config
