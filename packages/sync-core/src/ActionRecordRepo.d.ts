import { SqlClient } from "@effect/sql";
import { Effect, Option } from "effect";
import { ActionRecord } from "./models";
declare const ActionRecordRepo_base: Effect.Service.Class<ActionRecordRepo, "ActionRecordRepo", {
    readonly effect: Effect.Effect<{
        readonly all: (request: void) => Effect.Effect<readonly ActionRecord[], import("@effect/sql/SqlError").SqlError | import("effect/ParseResult").ParseError, never>;
        readonly findBySynced: (request: boolean) => Effect.Effect<readonly ActionRecord[], import("@effect/sql/SqlError").SqlError | import("effect/ParseResult").ParseError, never>;
        readonly findByTransactionId: (request: number) => Effect.Effect<Option.Option<ActionRecord>, import("@effect/sql/SqlError").SqlError | import("effect/ParseResult").ParseError, never>;
        readonly findLatestSynced: (request: void) => Effect.Effect<Option.Option<ActionRecord>, import("@effect/sql/SqlError").SqlError | import("effect/ParseResult").ParseError, never>;
        readonly allUnsynced: (request: void) => Effect.Effect<readonly ActionRecord[], import("@effect/sql/SqlError").SqlError | import("effect/ParseResult").ParseError, never>;
        readonly findByTag: (request: string) => Effect.Effect<readonly ActionRecord[], import("@effect/sql/SqlError").SqlError | import("effect/ParseResult").ParseError, never>;
        readonly findOlderThan: (request: number) => Effect.Effect<readonly ActionRecord[], import("@effect/sql/SqlError").SqlError | import("effect/ParseResult").ParseError, never>;
        readonly markAsSynced: (id: string) => import("@effect/sql/Statement").Statement<import("@effect/sql/SqlConnection").Row>;
        readonly findByIds: (request: readonly string[]) => Effect.Effect<readonly ActionRecord[], import("@effect/sql/SqlError").SqlError | import("effect/ParseResult").ParseError, never>;
        readonly deleteById: (id: string) => import("@effect/sql/Statement").Statement<import("@effect/sql/SqlConnection").Row>;
        readonly markLocallyApplied: (actionRecordId: string) => import("@effect/sql/Statement").Statement<import("@effect/sql/SqlConnection").Row>;
        readonly unmarkLocallyApplied: (actionRecordId: string) => import("@effect/sql/Statement").Statement<import("@effect/sql/SqlConnection").Row>;
        readonly isLocallyApplied: (actionRecordId: string) => Effect.Effect<boolean, import("@effect/sql/SqlError").SqlError | import("effect/ParseResult").ParseError, never>;
        readonly findUnappliedLocally: (request: void) => Effect.Effect<readonly ActionRecord[], import("@effect/sql/SqlError").SqlError | import("effect/ParseResult").ParseError, never>;
        readonly insert: (insert: {
            readonly args: {
                readonly [x: string]: unknown;
                readonly timestamp: number;
            };
            readonly synced: boolean;
            readonly _tag: string;
            readonly client_id: string;
            readonly transaction_id: number;
            readonly clock: {
                readonly vector: {
                    readonly [x: string]: number;
                };
                readonly timestamp: number;
            };
            readonly created_at: import("effect/DateTime").Utc;
        }) => Effect.Effect<ActionRecord, never, never>;
        readonly insertVoid: (insert: {
            readonly args: {
                readonly [x: string]: unknown;
                readonly timestamp: number;
            };
            readonly synced: boolean;
            readonly _tag: string;
            readonly client_id: string;
            readonly transaction_id: number;
            readonly clock: {
                readonly vector: {
                    readonly [x: string]: number;
                };
                readonly timestamp: number;
            };
            readonly created_at: import("effect/DateTime").Utc;
        }) => Effect.Effect<void, never, never>;
        readonly update: (update: {
            readonly id: string;
            readonly args: {
                readonly [x: string]: unknown;
                readonly timestamp: number;
            };
            readonly synced: boolean;
            readonly sortable_clock: string;
            readonly _tag: string;
            readonly client_id: string;
            readonly transaction_id: number;
            readonly clock: {
                readonly vector: {
                    readonly [x: string]: number;
                };
                readonly timestamp: number;
            };
            readonly created_at: import("effect/DateTime").Utc;
        }) => Effect.Effect<ActionRecord, never, never>;
        readonly updateVoid: (update: {
            readonly id: string;
            readonly args: {
                readonly [x: string]: unknown;
                readonly timestamp: number;
            };
            readonly synced: boolean;
            readonly sortable_clock: string;
            readonly _tag: string;
            readonly client_id: string;
            readonly transaction_id: number;
            readonly clock: {
                readonly vector: {
                    readonly [x: string]: number;
                };
                readonly timestamp: number;
            };
            readonly created_at: import("effect/DateTime").Utc;
        }) => Effect.Effect<void, never, never>;
        readonly findById: (id: string) => Effect.Effect<Option.Option<ActionRecord>, never, never>;
        readonly delete: (id: string) => Effect.Effect<void, never, never>;
    }, never, SqlClient.SqlClient>;
    readonly dependencies: readonly [];
}>;
/**
 * Repository service for ActionRecords with type-safe queries
 */
export declare class ActionRecordRepo extends ActionRecordRepo_base {
}
export {};
//# sourceMappingURL=ActionRecordRepo.d.ts.map