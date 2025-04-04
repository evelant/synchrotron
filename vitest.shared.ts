import * as path from "node:path"
import tsconfigPaths from "vite-tsconfig-paths"
import type { ViteUserConfig } from "vitest/config"
const alias = (pkg: string, dir = pkg) => {
	const name = pkg === "effect" ? "effect" : `@effect/${pkg}`
	const target = process.env.TEST_DIST !== undefined ? path.join("dist", "dist", "esm") : "src"
	return {
		[`${name}/test`]: path.join(__dirname, "packages", dir, "test"),
		[`${name}`]: path.join(__dirname, "packages", dir, target)
	}
}

const config: ViteUserConfig = {
	plugins: [tsconfigPaths()],
	esbuild: {
		target: "esnext"
	},
	optimizeDeps: {
		exclude: ["bun:sqlite"]
	},
	resolve: {
		preserveSymlinks: true
	},
	test: {
		disableConsoleIntercept: true,
		// setupFiles: [path.join(__dirname, "vitest.setup.ts")],
		fakeTimers: {
			toFake: undefined
		},
		sequence: {
			concurrent: false
		},
		maxConcurrency: 1,
		include: ["test/**/*.test.ts"],
		alias: {
			...alias("app"),
			...alias("sql-pglite"),
			...alias("sync")
		}
	}
}

export default config
