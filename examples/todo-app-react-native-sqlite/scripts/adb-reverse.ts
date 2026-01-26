import { spawnSync } from "node:child_process"

const DEFAULT_PORTS = [3010, 5133, 8081, 19000, 19001, 19002] as const

const parsePorts = (value: string): number[] =>
	value
		.split(/[,\s]+/g)
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => Number(part))
		.filter((port) => Number.isInteger(port) && port > 0 && port < 65536)

const ports =
	process.argv.length > 2
		? parsePorts(process.argv.slice(2).join(","))
		: process.env.ADB_REVERSE_PORTS
			? parsePorts(process.env.ADB_REVERSE_PORTS)
			: [...DEFAULT_PORTS]

const adb = process.env.ADB ?? "adb"

const run = (args: string[]) =>
	spawnSync(adb, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"]
	})

const version = run(["version"])
if (version.error && (version.error as NodeJS.ErrnoException).code === "ENOENT") {
	console.warn(`[adb-reverse] Skipping (adb not found in PATH)`)
	process.exit(0)
}

const devicesResult = run(["devices"])
if (devicesResult.status !== 0) {
	console.warn(
		`[adb-reverse] Skipping (failed to list devices):\n${devicesResult.stderr || devicesResult.stdout}`
	)
	process.exit(0)
}

const deviceSerials = (devicesResult.stdout ?? "")
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line && !line.startsWith("List of devices"))
	.map((line) => line.split(/\s+/g))
	.filter((parts) => parts[0] && parts[1] === "device")
	.map((parts) => parts[0])

if (deviceSerials.length === 0) {
	console.warn(`[adb-reverse] No android devices/emulators detected; skipping`)
	process.exit(0)
}

for (const serial of deviceSerials) {
	for (const port of ports) {
		const result = run(["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`])
		if (result.status !== 0) {
			console.warn(
				`[adb-reverse] ${serial}: failed to reverse tcp:${port}:\n${result.stderr || result.stdout}`
			)
		}
	}
}

console.log(`[adb-reverse] Reversed ports (${ports.join(", ")}) for: ${deviceSerials.join(", ")}`)
