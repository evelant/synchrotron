/**
 * @since 1.0.0
 */
import { FileSystem } from "@effect/platform/FileSystem";
import { Path } from "@effect/platform/Path";
import * as Migrator from "@effect/sql/Migrator";
import type * as Client from "@effect/sql/SqlClient";
import type { SqlError } from "@effect/sql/SqlError";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PgLiteClient } from "./PgLiteClient.js";
/**
 * @since 1.0.0
 */
export * from "@effect/sql/Migrator";
/**
 * @since 1.0.0
 */
export * from "@effect/sql/Migrator/FileSystem";
/**
 * @category constructor
 * @since 1.0.0
 */
export declare const run: <R2 = never>(options: Migrator.MigratorOptions<R2>) => Effect.Effect<ReadonlyArray<readonly [id: number, name: string]>, Migrator.MigrationError | SqlError, FileSystem | Path | PgLiteClient | Client.SqlClient | R2>;
/**
 * @category layers
 * @since 1.0.0
 */
export declare const layer: <R>(options: Migrator.MigratorOptions<R>) => Layer.Layer<never, Migrator.MigrationError | SqlError, PgLiteClient | Client.SqlClient | FileSystem | Path | R>;
//# sourceMappingURL=PgLiteMigrator.d.ts.map