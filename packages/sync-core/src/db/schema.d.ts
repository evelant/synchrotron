import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
/**
 * Effect that initializes the sync tables schema
 */
export declare const createSyncTables: Effect.Effect<void, import("@effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
/**
 * Helper function to initialize triggers for all tables that need sync
 */
export declare const createPatchTriggersForTables: (tables: string[]) => Effect.Effect<void, import("@effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
//# sourceMappingURL=schema.d.ts.map