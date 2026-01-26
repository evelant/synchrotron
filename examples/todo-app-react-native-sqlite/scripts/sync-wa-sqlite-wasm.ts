import fs from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const copyWasmToPublic = async () => {
	const publicDir = path.join(projectRoot, "public")
	await fs.mkdir(publicDir, { recursive: true })

	const files = [
		{
			from: require.resolve("@effect/wa-sqlite/dist/wa-sqlite.wasm"),
			to: path.join(publicDir, "wa-sqlite.wasm")
		},
		{
			from: require.resolve("@effect/wa-sqlite/dist/wa-sqlite-async.wasm"),
			to: path.join(publicDir, "wa-sqlite-async.wasm")
		},
		{
			from: require.resolve("@effect/wa-sqlite/dist/wa-sqlite-jspi.wasm"),
			to: path.join(publicDir, "wa-sqlite-jspi.wasm")
		}
	] as const

	for (const file of files) {
		const [fromStat, toStat] = await Promise.all([
			fs.stat(file.from),
			fs.stat(file.to).catch(() => undefined)
		])

		if (toStat?.isFile() && toStat.size === fromStat.size) continue
		await fs.copyFile(file.from, file.to)
	}
}

copyWasmToPublic().catch((error) => {
	console.error("[sync-wa-sqlite-wasm] Failed to sync wa-sqlite wasm files:", error)
	process.exitCode = 1
})
