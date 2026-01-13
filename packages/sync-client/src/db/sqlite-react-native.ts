import * as Reactivity from "@effect/experimental/Reactivity"
import * as Client from "@effect/sql/SqlClient"
import type { Connection } from "@effect/sql/SqlConnection"
import { SqlError } from "@effect/sql/SqlError"
import * as Statement from "@effect/sql/Statement"
import * as Sqlite from "@op-engineering/op-sqlite"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

export interface SqliteReactNativeClientConfig {
	readonly filename: string
	readonly location?: string | undefined
	readonly encryptionKey?: string | undefined
	readonly spanAttributes?: Record<string, unknown> | undefined
	readonly transformResultNames?: ((str: string) => string) | undefined
	readonly transformQueryNames?: ((str: string) => string) | undefined
}

const getRows = (result: unknown): ReadonlyArray<Record<string, unknown>> => {
	if (typeof result !== "object" || result === null) return []
	const anyResult = result as any

	if (Array.isArray(anyResult.rows)) return anyResult.rows
	if (anyResult.rows && Array.isArray(anyResult.rows._array)) return anyResult.rows._array

	// Fallback for older drivers / alternative shapes.
	if (Array.isArray(anyResult.res)) return anyResult.res

	return []
}

const make = (options: SqliteReactNativeClientConfig) =>
	Effect.gen(function* () {
		const clientOptions: Parameters<typeof Sqlite.open>[0] = { name: options.filename }
		if (options.location !== undefined) clientOptions.location = options.location
		if (options.encryptionKey !== undefined) clientOptions.encryptionKey = options.encryptionKey

		const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
		const transformRows = options.transformResultNames
			? Statement.defaultTransforms(options.transformResultNames).array
			: undefined

		const makeConnection = Effect.gen(function* () {
			const executeSemaphore = yield* Effect.makeSemaphore(1)
			const db = Sqlite.open(clientOptions)
			yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

			const runRaw = (sql: string, params: ReadonlyArray<unknown> = []) =>
				executeSemaphore.withPermits(1)(
					Effect.tryPromise({
						try: () => db.execute(sql, params as any),
						catch: (cause) =>
							new SqlError({
								cause,
								message: "Failed to execute statement"
							})
					})
				)

			const runRows = (sql: string, params: ReadonlyArray<unknown> = []) =>
				Effect.map(runRaw(sql, params), getRows)

			const connection: Connection = {
				execute(
					sql: string,
					params: ReadonlyArray<unknown>,
					transformRows?: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
				) {
					return transformRows ? Effect.map(runRows(sql, params), transformRows) : runRows(sql, params)
				},
				executeRaw(sql: string, params: ReadonlyArray<unknown>) {
					return runRaw(sql, params)
				},
				executeValues(sql: string, params: ReadonlyArray<unknown>) {
					return Effect.map(
						runRows(sql, params),
						(results: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<ReadonlyArray<unknown>> => {
							if (results.length === 0) return []
							const first = results[0]!
							const columns = Object.keys(first)
							return results.map((row) => columns.map((column) => (row as any)[column]))
						}
					)
				},
				executeUnprepared(
					sql: string,
					params: ReadonlyArray<unknown>,
					transformRows: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
				) {
					return transformRows ? Effect.map(runRows(sql, params), transformRows) : runRows(sql, params)
				},
				executeStream(
					sql: string,
					params: ReadonlyArray<unknown>,
					transformRows: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
				) {
					return Stream.fromIterableEffect(this.execute(sql, params, transformRows))
				}
			}

			return connection
		})

		const connection = yield* makeConnection
		const reservationSemaphore = yield* Effect.makeSemaphore(1)
		const acquirer = Effect.acquireRelease(
			Effect.zipRight(reservationSemaphore.take(1), Effect.succeed(connection)),
			() => Effect.asVoid(reservationSemaphore.release(1))
		)

		return yield* Client.make({
			acquirer,
			compiler,
			spanAttributes: [
				...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
				[ATTR_DB_SYSTEM_NAME, "sqlite"]
			],
			transformRows
		})
	})

/**
 * SQLite (React Native) client layer backed by `@op-engineering/op-sqlite`.
 *
 * We implement this locally because `@effect/sql-sqlite-react-native` currently assumes an older
 * `op-sqlite` result shape (e.g. `rows._array`) and sync execution semantics.
 */
export const makeSqliteReactNativeClientLayer = (config: SqliteReactNativeClientConfig) =>
	Layer.scopedContext(
		Effect.map(make(config), (client) => Context.make(Client.SqlClient, client))
	).pipe(Layer.provide(Reactivity.layer))
