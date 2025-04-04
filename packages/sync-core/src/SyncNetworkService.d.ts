import { SqlClient } from "@effect/sql";
import { ClockService } from "@synchrotron/sync-core/ClockService";
import { Effect, Schema } from "effect";
import { type ActionModifiedRow, type ActionRecord } from "./models";
import type { BadArgument } from "@effect/platform/Error";
declare const RemoteActionFetchError_base: Schema.TaggedErrorClass<RemoteActionFetchError, "RemoteActionFetchError", {
    readonly _tag: Schema.tag<"RemoteActionFetchError">;
} & {
    message: typeof Schema.String;
    cause: Schema.optional<typeof Schema.Unknown>;
}>;
export declare class RemoteActionFetchError extends RemoteActionFetchError_base {
}
declare const NetworkRequestError_base: Schema.TaggedErrorClass<NetworkRequestError, "NetworkRequestError", {
    readonly _tag: Schema.tag<"NetworkRequestError">;
} & {
    message: typeof Schema.String;
    cause: Schema.optional<typeof Schema.Unknown>;
}>;
export declare class NetworkRequestError extends NetworkRequestError_base {
}
export interface FetchResult {
    actions: readonly ActionRecord[];
    modifiedRows: readonly ActionModifiedRow[];
}
export interface TestNetworkState {
    /** Simulated network delay in milliseconds */
    networkDelay: number;
    /** Whether network operations should fail */
    shouldFail: boolean;
}
declare const SyncNetworkService_base: Effect.Service.Class<SyncNetworkService, "SyncNetworkService", {
    /**
     * Live implementation using actual network requests
     */
    readonly effect: Effect.Effect<{
        fetchRemoteActions: () => Effect.Effect<FetchResult, RemoteActionFetchError | BadArgument>;
        sendLocalActions: (actions: readonly ActionRecord[], amrs: readonly ActionModifiedRow[]) => Effect.Effect<boolean, NetworkRequestError | BadArgument, never>;
    }, import("@effect/platform/Error").PlatformError, SqlClient.SqlClient | ClockService>;
}>;
export declare class SyncNetworkService extends SyncNetworkService_base {
}
export {};
//# sourceMappingURL=SyncNetworkService.d.ts.map