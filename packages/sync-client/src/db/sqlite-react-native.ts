import { SqliteClient } from "@effect/sql-sqlite-react-native"
import type { SqliteReactNativeClientConfig } from "./sqlite-react-native-config"

export type { SqliteReactNativeClientConfig } from "./sqlite-react-native-config"

/**
 * SQLite (React Native) client layer backed by `@effect/sql-sqlite-react-native` (which uses
 * `@op-engineering/op-sqlite` under the hood).
 *
 * Note: the web implementation lives in `sqlite-react-native.web.ts` and uses sqlite-wasm.
 */
export const makeSqliteReactNativeClientLayer = (config: SqliteReactNativeClientConfig) =>
	SqliteClient.layer(config)
