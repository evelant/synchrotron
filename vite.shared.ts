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
	build: {
		rollupOptions: {
			external: [],
			preserveSymlinks: false
		}
	},
	esbuild: {
		target: "esnext"
	},
	optimizeDeps: {
		exclude: ["@electric-sql/pglite"]
	},

	resolve: {
		preserveSymlinks: true
	}
}

export default config
