import { SqliteClient } from "@effect/sql-sqlite-react-native"

export const makeSqliteReactNativeClientLayer = (config: SqliteClient.SqliteClientConfig) =>
	SqliteClient.layer(config)

