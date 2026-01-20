import * as net from "node:net"

const run = async (command: string, args: string[], env?: Record<string, string>) => {
	const proc = Bun.spawn([command, ...args], {
		stdio: ["inherit", "inherit", "inherit"],
		env: { ...process.env, ...env }
	})
	const exitCode = await proc.exited
	return exitCode
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const args = process.argv.slice(2)
const keepDocker = args.includes("--keep-docker")
const noDocker = args.includes("--no-docker")
const resetDocker = args.includes("--reset-docker")

const dockerDownCommand = resetDocker ? "docker:reset" : "docker:down"

let testExitCode = 1
let startedDocker = false

const DefaultAdminDatabaseUrl = "postgresql://postgres:password@127.0.0.1:56321/electric"
const DefaultDatabaseUrl = "postgresql://synchrotron_app:password@127.0.0.1:56321/electric"
const DefaultDockerProjectName = "synchrotron-e2e-postgres"
const DefaultDockerHostPort = 56321

const canBindTcpPort = async (port: number, hostname = "0.0.0.0") =>
	await new Promise<boolean>((resolve) => {
		const server = net.createServer()
		server.unref()
		server.once("error", (error) => {
			// Some sandboxed environments block binding/listening entirely (EPERM).
			// Treat this as "unknown", so we keep the default port and let docker decide.
			if ((error as any)?.code === "EPERM") resolve(true)
			else resolve(false)
		})
		server.listen(port, hostname, () => {
			server.close(() => resolve(true))
		})
	})

const pickFreeTcpPort = async (hostname = "0.0.0.0") =>
	await new Promise<number>((resolve, reject) => {
		const fallbackRandomPort = () => 49_152 + Math.floor(Math.random() * (65_535 - 49_152))
		const server = net.createServer()
		server.unref()
		server.once("error", (error) => {
			if ((error as any)?.code === "EPERM") resolve(fallbackRandomPort())
			else reject(error)
		})
		server.listen(0, hostname, () => {
			const address = server.address()
			if (typeof address === "string" || address == null) {
				server.close(() => resolve(fallbackRandomPort()))
				return
			}
			const { port } = address
			server.close(() => resolve(port))
		})
	})

const makeAdminDatabaseUrl = (port: number) => `postgresql://postgres:password@127.0.0.1:${port}/electric`
const makeDatabaseUrl = (port: number) =>
	`postgresql://synchrotron_app:password@127.0.0.1:${port}/electric`

const adminDatabaseUrlFromEnv =
	process.env.E2E_ADMIN_DATABASE_URL ?? (noDocker ? process.env.ADMIN_DATABASE_URL : undefined)
const databaseUrlFromEnv = process.env.E2E_DATABASE_URL ?? (noDocker ? process.env.DATABASE_URL : undefined)

const shouldManageDocker = !noDocker && adminDatabaseUrlFromEnv == null && databaseUrlFromEnv == null

const dockerProjectName = process.env.E2E_DOCKER_PROJECT_NAME ?? DefaultDockerProjectName

let dockerHostPort = DefaultDockerHostPort
if (shouldManageDocker) {
	if (!(await canBindTcpPort(DefaultDockerHostPort))) {
		dockerHostPort = await pickFreeTcpPort()
	}
}

let adminDatabaseUrl =
	adminDatabaseUrlFromEnv ??
	(shouldManageDocker ? makeAdminDatabaseUrl(dockerHostPort) : DefaultAdminDatabaseUrl)
let databaseUrl =
	databaseUrlFromEnv ?? (shouldManageDocker ? makeDatabaseUrl(dockerHostPort) : DefaultDatabaseUrl)

const canConnectTcp = async (url: string) => {
	const timeoutMs = 750
	const parsed = new URL(url)
	const hostname = parsed.hostname || "127.0.0.1"
	const port = parsed.port ? Number(parsed.port) : 5432

	const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
	// Avoid "localhost" in Bun's node:net polyfill: it can resolve to multiple addresses and trigger
	// a rare internalConnectMultipleTimeout crash when we destroy the socket early.
	const hostCandidates = isLocalhost ? ["127.0.0.1", "::1"] : [hostname]

	for (const host of hostCandidates) {
		const ok = await new Promise<boolean>((resolve) => {
			const socket = net.createConnection({ host, port })
			const done = (result: boolean) => {
				socket.removeAllListeners()
				socket.destroy()
				resolve(result)
			}
			socket.setTimeout(timeoutMs)
			socket.once("connect", () => done(true))
			socket.once("timeout", () => done(false))
			socket.once("error", () => done(false))
		})
		if (ok) return true
	}
	return false
}

const waitForTcp = async (url: string, params?: { readonly timeoutMs?: number; readonly intervalMs?: number }) => {
	const timeoutMs = params?.timeoutMs ?? 30_000
	const intervalMs = params?.intervalMs ?? 250
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (await canConnectTcp(url)) return true
		await sleep(intervalMs)
	}
	return false
}

try {
	const dockerEnv = shouldManageDocker
		? {
				POSTGRES_PORT: String(dockerHostPort),
				PROJECT_NAME: dockerProjectName
			}
		: undefined

	if (shouldManageDocker) {
		console.log(`[test:e2e:postgres] starting docker postgres…`)
		console.log(`[test:e2e:postgres] docker project: ${dockerProjectName}`)
		console.log(`[test:e2e:postgres] postgres host port: ${dockerHostPort}`)

		if (resetDocker) {
			await run("pnpm", ["--filter", "@synchrotron-examples/backend", "docker:reset"], dockerEnv ?? {})
		}

		const upExitCode = await run(
			"pnpm",
			["--filter", "@synchrotron-examples/backend", "docker:up:postgres"],
			dockerEnv ?? {}
		)

		if (upExitCode !== 0) {
			// If docker failed to start (commonly due to a port collision), retry once on an ephemeral port
			// after forcing a reset of the dedicated e2e compose project.
			dockerHostPort = await pickFreeTcpPort()
			adminDatabaseUrl = makeAdminDatabaseUrl(dockerHostPort)
			databaseUrl = makeDatabaseUrl(dockerHostPort)
			const retryEnv = { ...(dockerEnv ?? {}), POSTGRES_PORT: String(dockerHostPort) }
			console.log(`[test:e2e:postgres] docker start failed; retrying with postgres host port: ${dockerHostPort}`)
			await run("pnpm", ["--filter", "@synchrotron-examples/backend", "docker:reset"], retryEnv)
			const retryExitCode = await run(
				"pnpm",
				["--filter", "@synchrotron-examples/backend", "docker:up:postgres"],
				retryEnv
			)
			if (retryExitCode === 0) startedDocker = true
		} else startedDocker = true
	}

	// If we just started docker, allow a short grace period for the published port to become reachable.
	if (!(await waitForTcp(databaseUrl, { timeoutMs: 30_000, intervalMs: 250 }))) {
		console.error(`[test:e2e:postgres] Postgres is not reachable at ${databaseUrl}`)
		console.error(
			`[test:e2e:postgres] Start Postgres with:\n  pnpm --filter @synchrotron-examples/backend docker:up:postgres\nor rerun with:\n  pnpm test:e2e:postgres --no-docker\nand set E2E_DATABASE_URL/E2E_ADMIN_DATABASE_URL (or DATABASE_URL/ADMIN_DATABASE_URL).`
		)
		process.exit(1)
	}

	console.log(`[test:e2e:postgres] running vitest suite…`)
	testExitCode = await run(
		"pnpm",
		["--filter", "@synchrotron/sync-server", "test:e2e:postgres"],
		{ E2E_ADMIN_DATABASE_URL: adminDatabaseUrl, E2E_DATABASE_URL: databaseUrl }
	)
} finally {
	if (!keepDocker && shouldManageDocker && startedDocker) {
		console.log(`[test:e2e:postgres] stopping docker…`)
		await run(
			"pnpm",
			["--filter", "@synchrotron-examples/backend", dockerDownCommand],
			{
				POSTGRES_PORT: String(dockerHostPort),
				PROJECT_NAME: dockerProjectName
			}
		)
	}
}

process.exit(testExitCode)
