import { ActionRegistry } from "@synchrotron/sync-core/ActionRegistry";
import { Effect, Schema, type Fiber } from "effect";
import { ActionModifiedRowRepo } from "./ActionModifiedRowRepo";
import { ActionRecordRepo } from "./ActionRecordRepo";
import { ClockService } from "./ClockService";
import { Action, ActionRecord } from "./models";
import { SqlClient, type SqlError } from "@effect/sql";
import { SyncNetworkService } from "./SyncNetworkService";
declare const ActionExecutionError_base: Schema.TaggedErrorClass<ActionExecutionError, "ActionExecutionError", {
    readonly _tag: Schema.tag<"ActionExecutionError">;
} & {
    actionId: typeof Schema.String;
    cause: Schema.optional<typeof Schema.Unknown>;
}>;
export declare class ActionExecutionError extends ActionExecutionError_base {
}
declare const SyncError_base: Schema.TaggedErrorClass<SyncError, "SyncError", {
    readonly _tag: Schema.tag<"SyncError">;
} & {
    message: typeof Schema.String;
    cause: Schema.optional<typeof Schema.Unknown>;
}>;
export declare class SyncError extends SyncError_base {
}
declare const SyncService_base: Effect.Service.Class<SyncService, "SyncService", {
    readonly effect: Effect.Effect<{
        executeAction: <A extends Record<string, unknown>, EE, R>(action: Action<A, EE, R>) => Effect.Effect<ActionRecord, ActionExecutionError, R>;
        performSync: () => Effect.Effect<readonly ActionRecord[], SyncError, never>;
        startSyncListener: () => Effect.Effect<Fiber.RuntimeFiber<void>, never, never>;
        cleanupOldActionRecords: (retentionDays?: number) => Effect.Effect<boolean, SqlError.SqlError, never>;
    }, import("@effect/platform/Error").PlatformError, ActionRecordRepo | SqlClient.SqlClient | ActionModifiedRowRepo | ActionRegistry | ClockService | SyncNetworkService>;
    readonly dependencies: readonly [import("effect/Layer").Layer<ActionRecordRepo, never, SqlClient.SqlClient>, import("effect/Layer").Layer<ActionModifiedRowRepo, never, SqlClient.SqlClient>, import("effect/Layer").Layer<SyncNetworkService, import("@effect/platform/Error").PlatformError, SqlClient.SqlClient | ClockService>, import("effect/Layer").Layer<ActionRegistry, never, never>];
}>;
export declare class SyncService extends SyncService_base {
}
export {};
//# sourceMappingURL=SyncService.d.ts.map