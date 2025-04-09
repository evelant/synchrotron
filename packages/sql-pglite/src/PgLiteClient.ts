/**
 * @since 1.0.0
 */
import * as Reactivity from "@effect/experimental/Reactivity"
import * as Client from "@effect/sql/SqlClient"
import type { Connection } from "@effect/sql/SqlConnection"
import { SqlError } from "@effect/sql/SqlError"
import type { Custom, Fragment, Primitive } from "@effect/sql/Statement"
import * as Statement from "@effect/sql/Statement"
import type { DebugLevel, ParserOptions, PGlite, SerializerOptions } from "@electric-sql/pglite"
import * as Config from "effect/Config"
import type { ConfigError } from "effect/ConfigError"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"

// Define OpenTelemetry constants since we can't import the package
const SEMATTRS_DB_SYSTEM = "db.system"
const DBSYSTEMVALUES_POSTGRESQL = "postgresql"
const SEMATTRS_DB_NAME = "db.name"

/**
 * @category extensions
 * @since 1.0.0
 */
// Extract the namespace type from an extension definition
export type ExtractNamespace<T> = T extends {
	setup: (...args: Array<any>) => Promise<infer R>
}
	? R extends { namespaceObj: infer N }
		? N
		: {}
	: {}

/**
 * @category extensions
 * @since 1.0.0
 */
// Extract all extension namespaces from an extensions object
export type ExtractExtensionNamespaces<T extends Record<string, any>> = {
	[K in keyof T]: ExtractNamespace<T[K]>
}

/**
 * @category extensions
 * @since 1.0.0
 */
// Create a type with extension namespaces as properties
export type ExtensionsToNamespaces<T extends Record<string, any>> = {
	[K in keyof T as K extends string ? K : never]: ExtractNamespace<T[K]>
}

/**
 * @category type ids
 * @since 1.0.0
 */
export const TypeId: unique symbol = Symbol.for("@effect/sql-pglite/PgLiteClient")

/**
 * @category type ids
 * @since 1.0.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 1.0.0
 */
export interface PgLiteClient<Extensions extends Record<string, any> = {}>
	extends Client.SqlClient {
	readonly [TypeId]: TypeId
	readonly config: PgLiteClientConfig
	readonly pg: PGlite
	readonly json: (_: unknown) => Fragment
	readonly array: (_: ReadonlyArray<Primitive>) => Fragment
	readonly listen: (channel: string) => Stream.Stream<string, SqlError>
	readonly notify: (channel: string, payload: string) => Effect.Effect<void, SqlError>
	readonly extensions: ExtensionsToNamespaces<Extensions>
}

/**
 * @category tags
 * @since 1.0.0
 */
export const PgLiteClient = Context.GenericTag<PgLiteClient<any>>("@effect/sql-pglite/PgLiteClient")

/**
 * Creates a tag for a PgLiteClient with specific extensions.
 * Use this when you need to preserve extension types when retrieving the client from the context.
 *
 * @example
 * ```ts
 * import * as PgLiteClient from "@effect/sql-pglite/PgLiteClient"
 * import * as Effect from "effect/Effect"
 * import { vector } from "@electric-sql/pglite-vector"
 *
 * // Create a tag for your client with extensions
 * const MyClient = PgLiteClient.tag<{
 *   vector: typeof vector
 * }>(Symbol.for("@app/MyClient"))
 *
 * // Use the tag to retrieve the client with correct extension types
 * const program = Effect.gen(function*() {
 *   const client = yield* MyClient
 *   // client.extensions.vector is properly typed
 * })
 * ```
 *
 * @category tags
 * @since 1.0.0
 */
// export const tag = <Extensions extends Record<string, any> = {}>(symbol: symbol) =>
// 	Context.GenericTag<PgLiteClient<Extensions>, PgLiteClient<Extensions>>(symbol.toString())

/**
 * @category constructors
 * @since 1.0.0
 */
export interface PgLiteClientConfig {
	readonly dataDir?: string | undefined
	readonly debug?: DebugLevel | undefined
	readonly relaxedDurability?: boolean | undefined
	readonly username?: string | undefined
	readonly database?: string | undefined
	readonly initialMemory?: number | undefined
	readonly transformResultNames?: ((str: string) => string) | undefined
	readonly transformQueryNames?: ((str: string) => string) | undefined
	readonly transformJson?: boolean | undefined
	readonly applicationName?: string | undefined
	readonly spanAttributes?: Record<string, unknown> | undefined
	readonly fs?: any | undefined
	readonly loadDataDir?: Blob | File | undefined
	readonly wasmModule?: WebAssembly.Module | undefined
	readonly fsBundle?: Blob | File | undefined
	readonly parsers?: ParserOptions | undefined
	readonly serializers?: SerializerOptions | undefined
}

/**
 * @category constructors
 * @since 1.0.0
 */
export const make = <Extensions extends Record<string, any> = object>(
	options: Omit<PgLiteClientConfig, "extensions"> & { extensions?: Extensions }
): Effect.Effect<PgLiteClient<Extensions>, SqlError, Scope.Scope | Reactivity.Reactivity> =>
	Effect.gen(function* () {
		const compiler = makeCompiler(options.transformQueryNames, options.transformJson)
		const transformRows = options.transformResultNames
			? Statement.defaultTransforms(options.transformResultNames, options.transformJson).array
			: undefined

		// Import PGlite dynamically to avoid issues with bundlers
		const { PGlite } = yield* Effect.tryPromise({
			try: () => import("@electric-sql/pglite"),
			catch: (cause) => new SqlError({ cause, message: "PgLiteClient: Failed to import PGlite" })
		})

		// Create PGlite instance
		const client: PGlite = yield* Effect.tryPromise({
			try: () =>
				// GlobalValue.globalValue("pglite", () =>
				PGlite.create(
					options.dataDir || "", // First argument is dataDir
					{
						// Second argument is options object
						debug: options.debug,
						relaxedDurability: options.relaxedDurability,
						username: options.username || undefined,
						database: options.database || undefined,
						initialMemory: options.initialMemory,
						fs: options.fs,
						extensions: options.extensions,
						loadDataDir: options.loadDataDir,
						wasmModule: options.wasmModule,
						fsBundle: options.fsBundle,
						parsers: options.parsers,
						serializers: options.serializers
					} as any // Cast to any to avoid TypeScript errors with optional properties
					// )
				),
			catch: (cause) => new SqlError({ cause, message: "PgLiteClient: Failed to connect" })
		})

		// Test connection
		yield* Effect.tryPromise({
			try: () => client.query("SELECT 1"),
			catch: (cause) => new SqlError({ cause, message: "PgLiteClient: Failed to query" })
		})

		// Unlike PgClient, we don't close the connection in the release phase
		// because PGlite is a single-connection database and closing it would
		// shut down the entire database
		yield* Effect.addFinalizer(() => Effect.succeed(void 0))

		class ConnectionImpl implements Connection {
			constructor(readonly pg: PGlite) {}

			private run(query: Promise<any>) {
				return Effect.async<ReadonlyArray<any>, SqlError>((resume) => {
					query.then(
						(result) => {
							resume(Effect.succeed(result.rows))
						},
						(cause) => {
							console.error("Failed to execute statement:", cause)
							resume(new SqlError({ cause, message: "Failed to execute statement" }))
						}
					)
					// PGlite doesn't have a cancel method like postgres.js
					return Effect.succeed(void 0)
				})
			}

			execute(
				sql: string,
				params: ReadonlyArray<Primitive>,
				transformRows?: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined,
				unprepared?: boolean
			) {
				console.log("Executing query:", sql.substring(0, 100), params)
				return transformRows
					? Effect.map(
							this.run(
								unprepared ? this.pg.exec(sql, params as any) : this.pg.query(sql, params as any)
							),
							transformRows
						)
					: unprepared
						? this.run(this.pg.exec(sql, params as any))
						: this.run(this.pg.query(sql, params as any))
			}
			executeRaw(sql: string, params: ReadonlyArray<Primitive>) {
				console.log("Executing raw query:", sql.substring(0, 100), params)

				return this.run(this.pg.exec(sql, params as any))
			}
			executeWithoutTransform(sql: string, params: ReadonlyArray<Primitive>) {
				console.log("Executing query without transform:", sql.substring(0, 100), params)
				return this.run(this.pg.query(sql, params as any))
			}
			executeValues(sql: string, params: ReadonlyArray<Primitive>) {
				console.log("Executing values query:", sql.substring(0, 100), params)
				// PGlite doesn't have a values() method like postgres.js
				// We'll just return the regular query results
				return this.run(this.pg.query(sql, params as any))
			}
			executeUnprepared(
				sql: string,
				params: ReadonlyArray<Primitive>,
				transformRows: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
			) {
				console.log("Executing unprepared query:", sql.substring(0, 100), params)
				return this.execute(sql, params, transformRows, true)
			}
			executeStream(
				sql: string,
				params: ReadonlyArray<Primitive>,
				transformRows: (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined
			) {
				console.log("Executing stream query:", sql.substring(0, 100), params)
				// PGlite doesn't have a cursor method like postgres.js
				// We'll fetch all results at once and convert to a stream
				return Stream.fromEffect(
					Effect.map(this.run(this.pg.query(sql, params as any)), (rows) => {
						const result = transformRows ? transformRows(rows) : rows
						return result
					})
				).pipe(Stream.flatMap(Stream.fromIterable))
			}
		}

		return Object.assign(
			yield* Client.make({
				// For PGlite, we use the same connection for both regular queries and transactions
				// since it's a single-connection database
				acquirer: Effect.succeed(new ConnectionImpl(client)),
				compiler,
				spanAttributes: [
					...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
					[SEMATTRS_DB_SYSTEM, DBSYSTEMVALUES_POSTGRESQL],
					[SEMATTRS_DB_NAME, options.database ?? options.username ?? "postgres"],
					["server.address", "localhost"],
					["server.port", 0] // PGlite doesn't use a port
				],
				transformRows
			}),
			{
				[TypeId]: TypeId as TypeId,
				config: {
					...options
				},
				pg: client,
				json: (_: unknown) => PgLiteJson([_]),
				array: (_: ReadonlyArray<Primitive>) => PgLiteArray([_]),
				extensions: options.extensions ? (client as any) : ({} as any),
				listen: (channel: string) =>
					Stream.asyncPush<string, SqlError>((emit) =>
						Effect.tryPromise({
							try: async () => {
								const unsub = await client.listen(channel, (payload) => emit.single(payload))
								return { unsub }
							},
							catch: (cause) => new SqlError({ cause, message: "Failed to listen" })
						}).pipe(
							Effect.map(({ unsub }) =>
								Effect.tryPromise({
									try: () => unsub(),
									catch: (cause) => new SqlError({ cause, message: "Failed to unlisten" })
								})
							)
						)
					),
				notify: (channel: string, payload: string) =>
					Effect.tryPromise({
						try: () => client.query(`NOTIFY ${channel}, '${payload}'`),
						catch: (cause) => new SqlError({ cause, message: "Failed to notify" })
					}).pipe(Effect.map(() => void 0))
			}
		)
	})

/**
 * @category layers
 * @since 1.0.0
 */
export const layerConfig = <Extensions extends Record<string, any> = {}>(
	config: Config.Config.Wrap<PgLiteClientConfig>
): Layer.Layer<PgLiteClient<Extensions> | Client.SqlClient, ConfigError | SqlError> =>
	Layer.scopedContext(
		Config.unwrap(config).pipe(
			Effect.flatMap(make<Extensions>),
			Effect.map((client) =>
				Context.make(PgLiteClient, client as PgLiteClient<Extensions>).pipe(
					Context.add(Client.SqlClient, client)
				)
			)
		)
	).pipe(Layer.provide(Reactivity.layer))

/**
 * @category layers
 * @since 1.0.0
 */
export const layer = <Extensions extends Record<string, any> = {}>(
	config: PgLiteClientConfig & { extensions?: Extensions }
): Layer.Layer<PgLiteClient<Extensions> | Client.SqlClient, ConfigError | SqlError> =>
	Layer.scopedContext(
		Effect.map(make<Extensions>(config), (client) =>
			Context.make(PgLiteClient, client as PgLiteClient<Extensions>).pipe(
				Context.add(Client.SqlClient, client)
			)
		)
	).pipe(Layer.provide(Reactivity.layer))

/**
 * @category helpers
 * @since 1.0.0
 */
export const tag = <Extensions extends Record<string, any> = {}>() =>
	PgLiteClient as Context.Tag<PgLiteClient<Extensions> | Client.SqlClient, PgLiteClient<Extensions>>

/**
 * @category constructor
 * @since 1.0.0
 */
export const makeCompiler = (
	transform?: (_: string) => string,
	transformJson = true
): Statement.Compiler => {
	// PGlite doesn't have a pg.json or pg.array method like postgres.js
	// We'll create our own custom handlers

	const transformValue =
		transformJson && transform ? Statement.defaultTransforms(transform).value : undefined

	return Statement.makeCompiler<PgLiteCustom>({
		dialect: "pg",
		placeholder(_) {
			return `$${_}`
		},
		onIdentifier: transform
			? function (value, withoutTransform) {
					return withoutTransform ? escape(value) : escape(transform(value))
				}
			: escape,
		onRecordUpdate(placeholders, valueAlias, valueColumns, values, returning) {
			return [
				`(values ${placeholders}) AS ${valueAlias}${valueColumns}${returning ? ` RETURNING ${returning[0]}` : ""}`,
				returning ? values.flat().concat(returning[1]) : values.flat()
			]
		},
		onCustom(type: PgLiteCustom, placeholder, withoutTransform) {
			switch (type.kind) {
				case "PgLiteJson": {
					// For PGlite, we'll use a parameter placeholder and let PGlite handle the JSON serialization
					// This ensures proper handling of JSON types in PostgreSQL
					const value =
						withoutTransform || transformValue === undefined
							? type.i0[0]
							: transformValue(type.i0[0])
					return [placeholder(undefined), [value]]
				}
				case "PgLiteArray": {
					// For PGlite, we'll use a parameter placeholder and let PGlite handle the array serialization
					// This ensures proper handling of array types in PostgreSQL
					const arrayValue = type.i0[0]
					return [placeholder(undefined), [arrayValue]]
				}
				default: {
					throw new Error(`Unknown custom type: ${type}`)
				}
			}
		}
	})
}

const escape = Statement.defaultEscape('"')

/**
 * @category custom types
 * @since 1.0.0
 */
export type PgLiteCustom = PgLiteJson | PgLiteArray

/**
 * @category custom types
 * @since 1.0.0
 */
export interface PgLiteJson extends Custom<"PgLiteJson", [unknown]> {}

/**
 * @category custom types
 * @since 1.0.0
 */
export const PgLiteJson = Statement.custom<PgLiteJson>("PgLiteJson")

/**
 * @category custom types
 * @since 1.0.0
 */
export interface PgLiteArray extends Custom<"PgLiteArray", [ReadonlyArray<Primitive>]> {}

/**
 * @category custom types
 * @since 1.0.0
 */
export const PgLiteArray = Statement.custom<PgLiteArray>("PgLiteArray")
