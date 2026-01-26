import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const timeoutMs = Number(process.env.POSTGRES_WAIT_TIMEOUT_MS ?? "30000")
const intervalMs = Number(process.env.POSTGRES_WAIT_INTERVAL_MS ?? "250")

const start = Date.now()

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const runPgIsReady = (): boolean => {
	const result = spawnSync(
		"docker",
		[
			"compose",
			"-f",
			"./docker-compose.yml",
			"exec",
			"-T",
			"postgres",
			"pg_isready",
			"-U",
			"postgres",
			"-d",
			"electric"
		],
		{
			cwd: projectRoot,
			stdio: "ignore"
		}
	)
	return result.status === 0
}

while (Date.now() - start < timeoutMs) {
	if (runPgIsReady()) process.exit(0)
	await new Promise((r) => setTimeout(r, intervalMs))
}

console.error(
	`[wait-for-postgres] Timed out after ${timeoutMs}ms waiting for Postgres to become ready (pg_isready).`
)
process.exit(1)
