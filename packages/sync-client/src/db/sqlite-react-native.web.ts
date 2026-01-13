import { SqliteClient } from "@effect/sql-sqlite-wasm"
import type { SqliteReactNativeClientConfig } from "./sqlite-react-native-config"

export type { SqliteReactNativeClientConfig } from "./sqlite-react-native-config"

/**
 * React Native Web implementation of the "react-native sqlite" layer.
 *
 * Uses in-memory sqlite-wasm (no native modules).
 */
export const makeSqliteReactNativeClientLayer = (config: SqliteReactNativeClientConfig) =>
	SqliteClient.layerMemory({
		...(config.spanAttributes ? { spanAttributes: config.spanAttributes } : {}),
		...(config.transformResultNames ? { transformResultNames: config.transformResultNames } : {}),
		...(config.transformQueryNames ? { transformQueryNames: config.transformQueryNames } : {})
	})
