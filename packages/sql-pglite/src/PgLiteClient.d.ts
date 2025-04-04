/**
 * @since 1.0.0
 */
import * as Reactivity from "@effect/experimental/Reactivity";
import * as Client from "@effect/sql/SqlClient";
import { SqlError } from "@effect/sql/SqlError";
import type { Custom, Fragment, Primitive } from "@effect/sql/Statement";
import * as Statement from "@effect/sql/Statement";
import type { DebugLevel, ParserOptions, SerializerOptions } from "@electric-sql/pglite";
import * as Config from "effect/Config";
import type { ConfigError } from "effect/ConfigError";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
/**
 * @category extensions
 * @since 1.0.0
 */
export type ExtractNamespace<T> = T extends {
    setup: (...args: Array<any>) => Promise<infer R>;
} ? R extends {
    namespaceObj: infer N;
} ? N : {} : {};
/**
 * @category extensions
 * @since 1.0.0
 */
export type ExtractExtensionNamespaces<T extends Record<string, any>> = {
    [K in keyof T]: ExtractNamespace<T[K]>;
};
/**
 * @category extensions
 * @since 1.0.0
 */
export type ExtensionsToNamespaces<T extends Record<string, any>> = {
    [K in keyof T as K extends string ? K : never]: ExtractNamespace<T[K]>;
};
/**
 * @category type ids
 * @since 1.0.0
 */
export declare const TypeId: unique symbol;
/**
 * @category type ids
 * @since 1.0.0
 */
export type TypeId = typeof TypeId;
/**
 * @category models
 * @since 1.0.0
 */
export interface PgLiteClient<Extensions extends Record<string, any> = {}> extends Client.SqlClient {
    readonly [TypeId]: TypeId;
    readonly config: PgLiteClientConfig;
    readonly json: (_: unknown) => Fragment;
    readonly array: (_: ReadonlyArray<Primitive>) => Fragment;
    readonly listen: (channel: string) => Stream.Stream<string, SqlError>;
    readonly notify: (channel: string, payload: string) => Effect.Effect<void, SqlError>;
    readonly extensions: ExtensionsToNamespaces<Extensions>;
}
/**
 * @category tags
 * @since 1.0.0
 */
export declare const PgLiteClient: Context.Tag<PgLiteClient<any>, PgLiteClient<any>>;
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
/**
 * @category constructors
 * @since 1.0.0
 */
export interface PgLiteClientConfig {
    readonly dataDir?: string | undefined;
    readonly debug?: DebugLevel | undefined;
    readonly relaxedDurability?: boolean | undefined;
    readonly username?: string | undefined;
    readonly database?: string | undefined;
    readonly initialMemory?: number | undefined;
    readonly transformResultNames?: ((str: string) => string) | undefined;
    readonly transformQueryNames?: ((str: string) => string) | undefined;
    readonly transformJson?: boolean | undefined;
    readonly applicationName?: string | undefined;
    readonly spanAttributes?: Record<string, unknown> | undefined;
    readonly fs?: any | undefined;
    readonly loadDataDir?: Blob | File | undefined;
    readonly wasmModule?: WebAssembly.Module | undefined;
    readonly fsBundle?: Blob | File | undefined;
    readonly parsers?: ParserOptions | undefined;
    readonly serializers?: SerializerOptions | undefined;
}
/**
 * @category constructors
 * @since 1.0.0
 */
export declare const make: <Extensions extends Record<string, any> = object>(options: Omit<PgLiteClientConfig, "extensions"> & {
    extensions?: Extensions;
}) => Effect.Effect<PgLiteClient<Extensions>, SqlError, Scope.Scope | Reactivity.Reactivity>;
/**
 * @category layers
 * @since 1.0.0
 */
export declare const layerConfig: <Extensions extends Record<string, any> = {}>(config: Config.Config.Wrap<PgLiteClientConfig>) => Layer.Layer<PgLiteClient<Extensions> | Client.SqlClient, ConfigError | SqlError>;
/**
 * @category layers
 * @since 1.0.0
 */
export declare const layer: <Extensions extends Record<string, any> = {}>(config: PgLiteClientConfig & {
    extensions?: Extensions;
}) => Layer.Layer<PgLiteClient<Extensions> | Client.SqlClient, ConfigError | SqlError>;
/**
 * @category helpers
 * @since 1.0.0
 */
export declare const tag: <Extensions extends Record<string, any> = {}>() => Context.Tag<PgLiteClient<Extensions>, PgLiteClient<Extensions>>;
/**
 * @category constructor
 * @since 1.0.0
 */
export declare const makeCompiler: (transform?: (_: string) => string, transformJson?: boolean) => Statement.Compiler;
/**
 * @category custom types
 * @since 1.0.0
 */
export type PgLiteCustom = PgLiteJson | PgLiteArray;
/**
 * @category custom types
 * @since 1.0.0
 */
export interface PgLiteJson extends Custom<"PgLiteJson", [unknown]> {
}
/**
 * @category custom types
 * @since 1.0.0
 */
export declare const PgLiteJson: (i0: [unknown], i1: void, i2: void) => Fragment;
/**
 * @category custom types
 * @since 1.0.0
 */
export interface PgLiteArray extends Custom<"PgLiteArray", [ReadonlyArray<Primitive>]> {
}
/**
 * @category custom types
 * @since 1.0.0
 */
export declare const PgLiteArray: (i0: [readonly Primitive[]], i1: void, i2: void) => Fragment;
//# sourceMappingURL=PgLiteClient.d.ts.map