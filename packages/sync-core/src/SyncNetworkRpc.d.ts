import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import { ActionModifiedRow, ActionRecord } from "./models";
import { type NetworkRequestError as NetworkRequestErrorType, type RemoteActionFetchError as RemoteActionFetchErrorType } from "./SyncNetworkService";
declare const FetchRemoteActions_base: Schema.TaggedRequestClass<FetchRemoteActions, "FetchRemoteActions", {
    readonly _tag: Schema.tag<"FetchRemoteActions">;
} & {
    clientId: typeof Schema.String;
    lastSyncedClock: Schema.Struct<{
        vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
            default: () => {};
        }>;
        timestamp: Schema.optionalWith<typeof Schema.Number, {
            default: () => number;
        }>;
    }>;
}, Schema.Struct<{
    actions: Schema.Array$<typeof ActionRecord>;
    modifiedRows: Schema.Array$<typeof ActionModifiedRow>;
}>, typeof RemoteActionFetchErrorType>;
export declare class FetchRemoteActions extends FetchRemoteActions_base {
}
declare const SendLocalActions_base: Schema.TaggedRequestClass<SendLocalActions, "SendLocalActions", {
    readonly _tag: Schema.tag<"SendLocalActions">;
} & {
    clientId: typeof Schema.String;
    actions: Schema.Array$<typeof ActionRecord>;
    amrs: Schema.Array$<typeof ActionModifiedRow>;
}, typeof Schema.Boolean, typeof NetworkRequestErrorType>;
export declare class SendLocalActions extends SendLocalActions_base {
}
declare const SyncNetworkRpcGroup_base: RpcGroup.RpcGroup<Rpc.From<typeof FetchRemoteActions> | Rpc.From<typeof SendLocalActions>>;
export declare class SyncNetworkRpcGroup extends SyncNetworkRpcGroup_base {
}
export {};
//# sourceMappingURL=SyncNetworkRpc.d.ts.map