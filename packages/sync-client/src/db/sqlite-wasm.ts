import { SqliteClient } from "@effect/sql-sqlite-wasm"

export const makeSqliteWasmClientLayerMemory = (
	config: SqliteClient.SqliteClientMemoryConfig = {}
) => SqliteClient.layerMemory(config)

/**
 * Convenience in-memory SQLite (WASM) client.
 *
 * For persistent browser storage (e.g. OPFS) you'll likely want `SqliteClient.layer(...)`
 * with a Worker-based configuration instead.
 */
export const SqliteWasmClientMemoryLive = makeSqliteWasmClientLayerMemory()
