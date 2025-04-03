import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		workspace: ["packages/*"],
		setupFiles: ["./vitest-setup-client.ts"]
	}
})
