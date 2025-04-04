import { KeyValueStore } from "@effect/platform";
import { SqlClient } from "@effect/sql";
import { ActionRecordRepo } from "@synchrotron/sync-core/ActionRecordRepo";
import { Effect, Option } from "effect";
import * as HLC from "./HLC";
import { type ActionRecord } from "./models";
import { SyncError } from "@synchrotron/sync-core/SyncService";
declare const ClockService_base: Effect.Service.Class<ClockService, "ClockService", {
    readonly effect: Effect.Effect<{
        getNodeId: Effect.Effect<string & import("effect/Brand").Brand<"sync/clientId">, import("@effect/platform/Error").PlatformError, never>;
        getClientClock: Effect.Effect<{
            readonly vector: {
                readonly [x: string]: number;
            };
            readonly timestamp: number;
        }, import("@effect/sql/SqlError").SqlError | import("effect/ParseResult").ParseError | import("@effect/platform/Error").PlatformError, never>;
        incrementClock: Effect.Effect<{
            readonly vector: {
                readonly [x: string]: number;
            };
            readonly timestamp: number;
        }, import("@effect/sql/SqlError").SqlError | import("effect/ParseResult").ParseError | import("@effect/platform/Error").PlatformError, never>;
        getLastSyncedClock: Effect.Effect<{
            readonly vector: {
                readonly [x: string]: number;
            };
            readonly timestamp: number;
        }, import("@effect/sql/SqlError").SqlError | import("effect/ParseResult").ParseError | import("@effect/platform/Error").PlatformError, never>;
        getEarliestClock: (actions: readonly ActionRecord[]) => Option.Option<HLC.HLC>;
        getLatestClock: (actions: readonly ActionRecord[]) => Option.Option<HLC.HLC>;
        updateLastSyncedClock: () => Effect.Effect<void, import("@effect/sql/SqlError").SqlError | import("effect/ParseResult").ParseError | SyncError | import("@effect/platform/Error").PlatformError, never>;
        compareClock: (a: {
            clock: HLC.HLC;
            clientId: string;
        }, b: {
            clock: HLC.HLC;
            clientId: string;
        }) => number;
        mergeClock: (a: HLC.HLC, b: HLC.HLC) => HLC.HLC;
        sortClocks: <T extends {
            clock: HLC.HLC;
            clientId: string;
        }>(items: T[]) => T[];
        findLatestCommonClock: <T extends {
            clock: HLC.HLC;
            synced: boolean | undefined;
            client_id: string;
        }>(localActions: T[], remoteActions: T[]) => HLC.HLC | null;
    }, import("@effect/platform/Error").PlatformError, ActionRecordRepo | SqlClient.SqlClient | KeyValueStore.KeyValueStore>;
    readonly accessors: true;
    readonly dependencies: readonly [import("effect/Layer").Layer<ActionRecordRepo, never, SqlClient.SqlClient>];
}>;
/**
 * Service that manages Hybrid Logical Clocks (HLCs) for establishing
 * causal ordering of actions across distributed clients
 */
export declare class ClockService extends ClockService_base {
}
export {};
//# sourceMappingURL=ClockService.d.ts.map