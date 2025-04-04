import { Effect, Schema } from "effect";
import { Action } from "./models";
declare const UnknownActionError_base: Schema.TaggedErrorClass<UnknownActionError, "UnknownActionError", {
    readonly _tag: Schema.tag<"UnknownActionError">;
} & {
    actionTag: typeof Schema.String;
}>;
/**
 * Error for unknown action types
 */
export declare class UnknownActionError extends UnknownActionError_base {
}
export type ActionCreator = <A extends Record<string, unknown> = any, EE = any, R = never>(args: A) => Action<A, EE, R>;
declare const ActionRegistry_base: Effect.Service.Class<ActionRegistry, "ActionRegistry", {
    readonly effect: Effect.Effect<{
        getActionCreator: (tag: string) => ActionCreator | undefined;
        registerActionCreator: (tag: string, creator: ActionCreator) => void;
        hasActionCreator: (tag: string) => boolean;
        removeActionCreator: (tag: string) => boolean;
        getRegistrySize: () => number;
        defineAction: <A extends Record<string, unknown> & {
            timestamp: number;
        }, EE, R = never>(tag: string, actionFn: (args: A) => Effect.Effect<void, EE, R>) => (args: Omit<A, "timestamp"> & {
            timestamp?: number | undefined;
        }) => Action<A, EE, R>;
        rollbackAction: (args: Omit<{
            target_action_id: string;
            timestamp: number;
        }, "timestamp"> & {
            timestamp?: number | undefined;
        }) => Action<{
            target_action_id: string;
            timestamp: number;
        }, never, never>;
    }, never, never>;
}>;
/**
 * ActionRegistry Service
 * Manages a registry of action creators that can be used to create and execute actions
 */
export declare class ActionRegistry extends ActionRegistry_base {
}
export {};
//# sourceMappingURL=ActionRegistry.d.ts.map