const port = Number.parseInt(process.env.PORT ?? "5173", 10)

const distRoot = new URL("./dist/", import.meta.url)
const distIndexPath = new URL("./index.html", distRoot).pathname

const faviconPath = new URL("./favicon.ico", import.meta.url).pathname
const robotsPath = new URL("./robots.txt", import.meta.url).pathname

const distPgliteWasmPath = new URL("./pglite.wasm", distRoot).pathname
const distPgliteDataPath = new URL("./pglite.data", distRoot).pathname
const distUuidOsspBundlePath = new URL("./uuid-ossp.tar.gz", distRoot).pathname

const pgliteDist = new URL("../../node_modules/@electric-sql/pglite/dist/", import.meta.url)
const pgliteWasmPath = new URL("./pglite.wasm", pgliteDist).pathname
const pgliteDataPath = new URL("./pglite.data", pgliteDist).pathname
const uuidOsspBundlePath = new URL("./uuid-ossp.tar.gz", pgliteDist).pathname

function respondFile(file: BunFile): Response {
	return new Response(file, {
		headers: file.type ? { "Content-Type": file.type } : undefined
	})
}

async function serveFilePath(path: string): Promise<Response | null> {
	const file = Bun.file(path)
	if (!(await file.exists())) return null
	return respondFile(file)
}

function resolveDistPath(pathname: string): string | null {
	if (!pathname.startsWith("/")) return null
	if (pathname.includes("\0")) return null
	let decoded: string
	try {
		decoded = decodeURIComponent(pathname)
	} catch {
		return null
	}
	if (decoded.includes("..")) return null
	return new URL(decoded.slice(1), distRoot).pathname
}

const server = Bun.serve({
	port,
	async fetch(req) {
		const url = new URL(req.url)

		if (req.method !== "GET" && req.method !== "HEAD") {
			return new Response("Method Not Allowed", { status: 405 })
		}

		switch (url.pathname) {
			case "/favicon.ico": {
				return (await serveFilePath(faviconPath)) ?? new Response("Not Found", { status: 404 })
			}
			case "/robots.txt": {
				return (await serveFilePath(robotsPath)) ?? new Response("Not Found", { status: 404 })
			}
			case "/pglite.wasm": {
				return (
					(await serveFilePath(distPgliteWasmPath)) ??
					(await serveFilePath(pgliteWasmPath)) ??
					new Response("Not Found", { status: 404 })
				)
			}
			case "/pglite.data": {
				return (
					(await serveFilePath(distPgliteDataPath)) ??
					(await serveFilePath(pgliteDataPath)) ??
					new Response("Not Found", { status: 404 })
				)
			}
			case "/uuid-ossp.tar.gz": {
				return (
					(await serveFilePath(distUuidOsspBundlePath)) ??
					(await serveFilePath(uuidOsspBundlePath)) ??
					new Response("Not Found", { status: 404 })
				)
			}
		}

		const distPath = resolveDistPath(url.pathname)
		if (distPath) {
			const staticResponse = await serveFilePath(distPath)
			if (staticResponse) return staticResponse
		}

		const indexResponse = await serveFilePath(distIndexPath)
		if (indexResponse) return indexResponse

		return new Response(
			`Waiting for the frontend build.\n\nIn another terminal, run:\n\n  bun build ./index.html --outdir dist --watch\n`,
			{ status: 503 }
		)
	},
	development: {
		console: true
	}
})

console.log(`Todo app dev server running on ${server.url}`)
