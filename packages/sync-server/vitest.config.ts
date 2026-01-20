import wasm from "vite-plugin-wasm"
import { mergeConfig, type ViteUserConfig } from "vitest/config"
import shared from "../../vitest.shared.ts"

const config: ViteUserConfig = {
	plugins: [wasm()],
	test: {
		maxConcurrency: 1,
		setupFiles: ["./vitest-setup.ts"],
		// Postgres E2E runs are opt-in and have their own config/scripts.
		exclude: ["test/e2e-postgres/**"]
	}
}

export default mergeConfig(shared, config)
