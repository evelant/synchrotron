import { SqlClient, type SqlError } from "@effect/sql";
import { Effect } from "effect";
import { ActionModifiedRow } from "./models";
declare const ActionModifiedRowRepo_base: Effect.Service.Class<ActionModifiedRowRepo, "ActionModifiedRowRepo", {
    readonly effect: Effect.Effect<{
        readonly all: (request: void) => Effect.Effect<readonly ActionModifiedRow[], SqlError.SqlError | import("effect/ParseResult").ParseError, never>;
        readonly allUnsynced: (request: void) => Effect.Effect<readonly ActionModifiedRow[], SqlError.SqlError | import("effect/ParseResult").ParseError, never>;
        readonly findByActionRecordIds: (request: readonly string[]) => Effect.Effect<readonly ActionModifiedRow[], SqlError.SqlError | import("effect/ParseResult").ParseError, never>;
        readonly findByTransactionId: (request: number) => Effect.Effect<readonly ActionModifiedRow[], SqlError.SqlError | import("effect/ParseResult").ParseError, never>;
        readonly deleteByActionRecordIds: (...actionRecordId: string[]) => Effect.Effect<void, SqlError.SqlError, never>;
        readonly insert: (insert: {
            readonly id: string;
            readonly operation: "INSERT" | "UPDATE" | "DELETE";
            readonly forward_patches: {
                readonly [x: string]: unknown;
            };
            readonly reverse_patches: {
                readonly [x: string]: unknown;
            };
            readonly table_name: string;
            readonly row_id: string;
            readonly action_record_id: string;
            readonly sequence: number;
        }) => Effect.Effect<ActionModifiedRow, never, never>;
        readonly insertVoid: (insert: {
            readonly id: string;
            readonly operation: "INSERT" | "UPDATE" | "DELETE";
            readonly forward_patches: {
                readonly [x: string]: unknown;
            };
            readonly reverse_patches: {
                readonly [x: string]: unknown;
            };
            readonly table_name: string;
            readonly row_id: string;
            readonly action_record_id: string;
            readonly sequence: number;
        }) => Effect.Effect<void, never, never>;
        readonly update: (update: {
            readonly id: string;
            readonly operation: "INSERT" | "UPDATE" | "DELETE";
            readonly forward_patches: {
                readonly [x: string]: unknown;
            };
            readonly reverse_patches: {
                readonly [x: string]: unknown;
            };
            readonly table_name: string;
            readonly row_id: string;
            readonly action_record_id: string;
            readonly sequence: number;
        }) => Effect.Effect<ActionModifiedRow, never, never>;
        readonly updateVoid: (update: {
            readonly id: string;
            readonly operation: "INSERT" | "UPDATE" | "DELETE";
            readonly forward_patches: {
                readonly [x: string]: unknown;
            };
            readonly reverse_patches: {
                readonly [x: string]: unknown;
            };
            readonly table_name: string;
            readonly row_id: string;
            readonly action_record_id: string;
            readonly sequence: number;
        }) => Effect.Effect<void, never, never>;
        readonly findById: (id: string) => Effect.Effect<import("effect/Option").Option<ActionModifiedRow>, never, never>;
        readonly delete: (id: string) => Effect.Effect<void, never, never>;
    }, never, SqlClient.SqlClient>;
}>;
/**
 * Repository service for ActionModifiedRows with type-safe queries
 */
export declare class ActionModifiedRowRepo extends ActionModifiedRowRepo_base {
}
/**
 * Deep compares two sets of ActionModifiedRow arrays based on the *final* state
 * implied by the sequence of changes for each modified row.
 */
export declare const compareActionModifiedRows: (rowsA: readonly ActionModifiedRow[], rowsB: readonly ActionModifiedRow[]) => boolean;
export {};
//# sourceMappingURL=ActionModifiedRowRepo.d.ts.map