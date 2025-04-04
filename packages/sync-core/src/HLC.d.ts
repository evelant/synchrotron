import { Order, Schema } from "effect";
/**
 * A Hybrid Logical Clock (HLC) is a clock that combines a logical clock (LC) and a physical clock (PC)
 * to provide a consistent ordering of events in distributed systems.
 *
 * The HLC is a tuple of (timestamp, clock).
 *
 * The timestamp is the physical clock time in milliseconds.
 *
 * The clock is a record mapping client IDs to their logical counters, allowing for a total ordering of actions
 * even if the physical clocks are skewed between clients.
 */
export declare const HLC: Schema.Struct<{
    vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
        default: () => {};
    }>;
    timestamp: Schema.optionalWith<typeof Schema.Number, {
        default: () => number;
    }>;
}>;
export type HLC = typeof HLC.Type;
export declare const make: (options?: Partial<{
    timestamp: number;
    vector: Record<string, number>;
}>) => HLC;
export declare const valueForNode: ((id: string) => (self: HLC) => number) & ((self: HLC, id: string) => number);
export declare const increment: ((id: string) => (self: HLC) => HLC) & ((self: HLC, id: string) => HLC);
export declare const _order: ((otherClock: HLC) => (self: HLC) => -1 | 0 | 1) & ((self: HLC, otherClock: HLC) => -1 | 0 | 1);
export declare const order: Order.Order<{
    readonly vector: {
        readonly [x: string]: number;
    };
    readonly timestamp: number;
}>;
/**
 * Order HLCs with an explicit client ID tiebreaker
 */
export declare const orderWithClientId: ((otherClock: HLC, otherClientId: string, selfClientId: string) => (self: HLC) => -1 | 0 | 1) & ((self: HLC, otherClock: HLC, selfClientId: string, otherClientId: string) => -1 | 0 | 1);
/**
 * Create an Order instance with client ID tiebreaking
 */
export declare const makeOrderWithClientId: (selfClientId: string, otherClientId: string) => Order.Order<{
    readonly vector: {
        readonly [x: string]: number;
    };
    readonly timestamp: number;
}>;
/**
 * Create a new local mutation by incrementing the clock for the specified client ID.
 * The counter always increments and never resets, even when physical time advances.
 */
export declare const createLocalMutation: ((clientId: string) => (self: HLC) => HLC) & ((self: HLC, clientId: string) => HLC);
/**
 * Receive a remote mutation and merge it with the local clock.
 * This handles merging logical counters and advancing physical time appropriately.
 * Counters never reset, they are set to the maximum seen value.
 */
export declare const receiveRemoteMutation: ((incomingClock: HLC, clientId: string) => (self: HLC) => HLC) & ((self: HLC, incomingClock: HLC, clientId: string) => HLC);
/**
 * Check if one HLC is causally before another
 */
export declare const isBefore: ((otherClock: HLC) => (self: HLC) => boolean) & ((self: HLC, otherClock: HLC) => boolean);
/**
 * Check if one HLC is causally after another
 */
export declare const isAfter: ((otherClock: HLC) => (self: HLC) => boolean) & ((self: HLC, otherClock: HLC) => boolean);
/**
 * Check if two HLCs are concurrent (neither is causally before or after the other)
 * With vector clocks, we can detect concurrency more explicitly.
 */
export declare const isConcurrent: ((otherClock: HLC) => (self: HLC) => boolean) & ((self: HLC, otherClock: HLC) => boolean);
/**
 * Get all client IDs that have entries in the clock
 */
export declare const getClientIds: (self: HLC) => string[];
/**
 * Check if two HLCs are equal
 */
export declare const equals: ((otherClock: HLC) => (self: HLC) => boolean) & ((self: HLC, otherClock: HLC) => boolean);
//# sourceMappingURL=HLC.d.ts.map