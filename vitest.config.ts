import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		projects: ["packages/*"],
		setupFiles: ["./vitest-setup-client.ts"]
	}
})
