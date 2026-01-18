export async function deleteOpfsSqliteDbFiles(filename: string): Promise<readonly string[]> {
	const storage: any = (globalThis as any)?.navigator?.storage
	if (!storage || typeof storage.getDirectory !== "function") {
		throw new Error(
			"OPFS is not available (navigator.storage.getDirectory missing). Run on a secure origin (https or localhost) in a browser that supports OPFS."
		)
	}

	const root: any = await storage.getDirectory()

	// `@effect/sql-sqlite-wasm`'s OpfsWorker uses wa-sqlite's `AccessHandlePoolVFS` with the VFS name `"opfs"`.
	// That VFS stores DB state in OPFS under an `"opfs"` directory using randomized filenames, so deleting the
	// user-facing DB filename is not sufficient.
	const deleted: Array<string> = []
	try {
		const maxAttempts = 5
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				await root.removeEntry("opfs", { recursive: true })
				break
			} catch (e: any) {
				if (e?.name === "NotFoundError") break
				if (e?.name !== "NoModificationAllowedError" || attempt === maxAttempts) throw e
				await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
			}
		}
		deleted.push("opfs/")
	} catch (e: any) {
		if (e?.name !== "NotFoundError") throw e
	}

	const candidates = new Set<string>([
		filename,
		`${filename}-wal`,
		`${filename}-shm`,
		`${filename}-journal`
	])

	try {
		for await (const [name] of root.entries()) {
			if (name === filename || (typeof name === "string" && name.startsWith(`${filename}-`))) {
				candidates.add(name)
			}
		}
	} catch {
		// Ignore enumeration failures; we still try the common filenames above.
	}

	for (const name of candidates) {
		try {
			await root.removeEntry(name)
			deleted.push(name)
		} catch (e: any) {
			// NotFoundError is expected if (e.g.) WAL files don't exist.
			if (e?.name !== "NotFoundError") throw e
		}
	}

	return deleted
}
