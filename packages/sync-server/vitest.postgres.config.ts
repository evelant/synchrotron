import wasm from "vite-plugin-wasm"
import type { ViteUserConfig } from "vitest/config"
import shared from "../../vitest.shared.ts"

const config: ViteUserConfig = {
	...shared,
	plugins: [...(shared.plugins ?? []), wasm()],
	test: {
		...(shared.test ?? {}),
		include: ["test/e2e-postgres/**/*.test.ts"],
		setupFiles: ["./vitest-setup.ts"],
		maxConcurrency: 1
	}
}

export default config
