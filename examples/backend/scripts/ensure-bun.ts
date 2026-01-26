import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

type BunPaths = {
	bunExe: string
	installScript: string
}

const getBunPaths = (): BunPaths => {
	const packageJsonPath = require.resolve("bun/package.json")
	const bunDir = path.dirname(packageJsonPath)
	return {
		bunExe: path.join(bunDir, "bin", "bun.exe"),
		installScript: path.join(bunDir, "install.js")
	}
}

const hasNonEmptyFile = (filePath: string): boolean => {
	try {
		return fs.statSync(filePath).size > 0
	} catch {
		return false
	}
}

const main = () => {
	let paths: BunPaths
	try {
		paths = getBunPaths()
	} catch {
		console.error(
			"[ensure-bun] The `bun` npm package is not installed. Run `pnpm install` or install Bun globally: https://bun.sh/"
		)
		process.exit(1)
	}

	if (hasNonEmptyFile(paths.bunExe)) return

	console.log("[ensure-bun] Bun binary not initialized (postinstall blocked?). Initializing now…")
	const result = spawnSync("node", [paths.installScript], { stdio: "inherit" })
	if (result.status !== 0) process.exit(result.status ?? 1)

	if (!hasNonEmptyFile(paths.bunExe)) {
		console.error(
			"[ensure-bun] Bun initialization did not produce a usable binary. Try reinstalling dependencies or install Bun globally: https://bun.sh/"
		)
		process.exit(1)
	}
}

main()
