import wasm from "vite-plugin-wasm"
import { mergeConfig, type ViteUserConfig } from "vitest/config"
import shared from "../../vitest.shared.ts"

const config: ViteUserConfig = {
	plugins: [wasm()],
	test: {
		maxConcurrency: 1,
		setupFiles: ["./vitest-setup.ts"]
	}
}

export default mergeConfig(shared, config)
