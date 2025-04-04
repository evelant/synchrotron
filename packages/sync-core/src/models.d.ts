import { Model } from "@effect/sql";
import { Effect, Schema } from "effect";
/**
 * Generic Action for SyncService to apply changes
 *
 * An action needs to describe:
 * 1. A unique tag to identify the action
 * 2. A method to apply changes to the database
 * 3. Serializable arguments that capture all non-deterministic inputs to the action so that the action is pure and can be replayed on different clients with the same result
 */
export interface Action<A extends Record<string, unknown>, EE, R = never> {
    /**
     * Unique identifier for the action
     */
    _tag: string;
    /**
     * Apply the changes to the database.
     * Receives the original arguments plus the timestamp injected by executeAction.
     */
    execute: () => Effect.Effect<void, EE, R>;
    /**
     * Serializable arguments to be saved with the action for later replay
     * This now includes the timestamp.
     */
    args: A;
}
export declare const PatchesSchema: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
export interface Patches extends Schema.Schema.Type<typeof PatchesSchema> {
}
declare const ActionRecord_base: import("@effect/experimental/VariantSchema").Class<ActionRecord, {
    readonly id: Model.Generated<typeof Schema.String>;
    readonly _tag: typeof Schema.String;
    readonly client_id: typeof Schema.String;
    readonly transaction_id: typeof Schema.Number;
    readonly clock: Schema.Struct<{
        vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
            default: () => {};
        }>;
        timestamp: Schema.optionalWith<typeof Schema.Number, {
            default: () => number;
        }>;
    }>;
    readonly args: Schema.TypeLiteral<{
        timestamp: typeof Schema.Number;
    }, readonly [{
        readonly key: typeof Schema.String;
        readonly value: typeof Schema.Unknown;
    }]>;
    readonly created_at: Model.DateTimeFromDate;
    readonly synced: Schema.optionalWith<typeof Schema.Boolean, {
        default: () => false;
    }>;
    readonly sortable_clock: Model.Generated<typeof Schema.String>;
}, {
    readonly id: typeof Schema.String;
    readonly _tag: typeof Schema.String;
    readonly client_id: typeof Schema.String;
    readonly transaction_id: typeof Schema.Number;
    readonly clock: Schema.Struct<{
        vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
            default: () => {};
        }>;
        timestamp: Schema.optionalWith<typeof Schema.Number, {
            default: () => number;
        }>;
    }>;
    readonly args: Schema.TypeLiteral<{
        timestamp: typeof Schema.Number;
    }, readonly [{
        readonly key: typeof Schema.String;
        readonly value: typeof Schema.Unknown;
    }]>;
    readonly created_at: Model.DateTimeFromDate;
    readonly synced: Schema.optionalWith<typeof Schema.Boolean, {
        default: () => false;
    }>;
    readonly sortable_clock: typeof Schema.String;
}, {
    readonly id: string;
} & {
    readonly args: {
        readonly [x: string]: unknown;
        readonly timestamp: number;
    };
} & {
    readonly synced: boolean;
} & {
    readonly sortable_clock: string;
} & {
    readonly _tag: string;
} & {
    readonly client_id: string;
} & {
    readonly transaction_id: number;
} & {
    readonly clock: {
        readonly vector: {
            readonly [x: string]: number;
        };
        readonly timestamp: number;
    };
} & {
    readonly created_at: import("effect/DateTime").Utc;
}, Schema.Struct.Encoded<{
    readonly id: typeof Schema.String;
    readonly _tag: typeof Schema.String;
    readonly client_id: typeof Schema.String;
    readonly transaction_id: typeof Schema.Number;
    readonly clock: Schema.Struct<{
        vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
            default: () => {};
        }>;
        timestamp: Schema.optionalWith<typeof Schema.Number, {
            default: () => number;
        }>;
    }>;
    readonly args: Schema.TypeLiteral<{
        timestamp: typeof Schema.Number;
    }, readonly [{
        readonly key: typeof Schema.String;
        readonly value: typeof Schema.Unknown;
    }]>;
    readonly created_at: Model.DateTimeFromDate;
    readonly synced: Schema.optionalWith<typeof Schema.Boolean, {
        default: () => false;
    }>;
    readonly sortable_clock: typeof Schema.String;
}>, never, {
    readonly id: string;
} & {
    readonly args: {
        readonly [x: string]: unknown;
        readonly timestamp: number;
    };
} & {
    readonly synced?: boolean;
} & {
    readonly sortable_clock: string;
} & {
    readonly _tag: string;
} & {
    readonly client_id: string;
} & {
    readonly transaction_id: number;
} & {
    readonly clock: {
        readonly vector: {
            readonly [x: string]: number;
        };
        readonly timestamp: number;
    };
} & {
    readonly created_at: import("effect/DateTime").Utc;
}> & {
    readonly select: Schema.Struct<{
        readonly id: typeof Schema.String;
        readonly _tag: typeof Schema.String;
        readonly client_id: typeof Schema.String;
        readonly transaction_id: typeof Schema.Number;
        readonly clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
        readonly args: Schema.TypeLiteral<{
            timestamp: typeof Schema.Number;
        }, readonly [{
            readonly key: typeof Schema.String;
            readonly value: typeof Schema.Unknown;
        }]>;
        readonly created_at: Model.DateTimeFromDate;
        readonly synced: Schema.optionalWith<typeof Schema.Boolean, {
            default: () => false;
        }>;
        readonly sortable_clock: typeof Schema.String;
    }>;
    readonly insert: Schema.Struct<{
        readonly _tag: typeof Schema.String;
        readonly client_id: typeof Schema.String;
        readonly transaction_id: typeof Schema.Number;
        readonly clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
        readonly args: Schema.TypeLiteral<{
            timestamp: typeof Schema.Number;
        }, readonly [{
            readonly key: typeof Schema.String;
            readonly value: typeof Schema.Unknown;
        }]>;
        readonly created_at: Model.DateTimeFromDate;
        readonly synced: Schema.optionalWith<typeof Schema.Boolean, {
            default: () => false;
        }>;
    }>;
    readonly update: Schema.Struct<{
        readonly id: typeof Schema.String;
        readonly _tag: typeof Schema.String;
        readonly client_id: typeof Schema.String;
        readonly transaction_id: typeof Schema.Number;
        readonly clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
        readonly args: Schema.TypeLiteral<{
            timestamp: typeof Schema.Number;
        }, readonly [{
            readonly key: typeof Schema.String;
            readonly value: typeof Schema.Unknown;
        }]>;
        readonly created_at: Model.DateTimeFromDate;
        readonly synced: Schema.optionalWith<typeof Schema.Boolean, {
            default: () => false;
        }>;
        readonly sortable_clock: typeof Schema.String;
    }>;
    readonly json: Schema.Struct<{
        readonly id: typeof Schema.String;
        readonly _tag: typeof Schema.String;
        readonly client_id: typeof Schema.String;
        readonly transaction_id: typeof Schema.Number;
        readonly clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
        readonly args: Schema.TypeLiteral<{
            timestamp: typeof Schema.Number;
        }, readonly [{
            readonly key: typeof Schema.String;
            readonly value: typeof Schema.Unknown;
        }]>;
        readonly created_at: Model.DateTimeFromDate;
        readonly synced: Schema.optionalWith<typeof Schema.Boolean, {
            default: () => false;
        }>;
        readonly sortable_clock: typeof Schema.String;
    }>;
    readonly jsonCreate: Schema.Struct<{
        readonly _tag: typeof Schema.String;
        readonly client_id: typeof Schema.String;
        readonly transaction_id: typeof Schema.Number;
        readonly clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
        readonly args: Schema.TypeLiteral<{
            timestamp: typeof Schema.Number;
        }, readonly [{
            readonly key: typeof Schema.String;
            readonly value: typeof Schema.Unknown;
        }]>;
        readonly created_at: Model.DateTimeFromDate;
        readonly synced: Schema.optionalWith<typeof Schema.Boolean, {
            default: () => false;
        }>;
    }>;
    readonly jsonUpdate: Schema.Struct<{
        readonly _tag: typeof Schema.String;
        readonly client_id: typeof Schema.String;
        readonly transaction_id: typeof Schema.Number;
        readonly clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
        readonly args: Schema.TypeLiteral<{
            timestamp: typeof Schema.Number;
        }, readonly [{
            readonly key: typeof Schema.String;
            readonly value: typeof Schema.Unknown;
        }]>;
        readonly created_at: Model.DateTimeFromDate;
        readonly synced: Schema.optionalWith<typeof Schema.Boolean, {
            default: () => false;
        }>;
    }>;
};
/**
 * Effect-SQL model for ActionRecord
 */
export declare class ActionRecord extends ActionRecord_base {
}
/**
 * Model for tracking client sync status
 */
export declare const ClientId: Schema.brand<typeof Schema.String, "sync/clientId">;
export type ClientId = typeof ClientId.Type;
declare const ClientSyncStatusModel_base: import("@effect/experimental/VariantSchema").Class<ClientSyncStatusModel, {
    readonly client_id: Schema.brand<typeof Schema.String, "sync/clientId">;
    readonly current_clock: Schema.Struct<{
        vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
            default: () => {};
        }>;
        timestamp: Schema.optionalWith<typeof Schema.Number, {
            default: () => number;
        }>;
    }>;
    readonly last_synced_clock: Schema.Struct<{
        vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
            default: () => {};
        }>;
        timestamp: Schema.optionalWith<typeof Schema.Number, {
            default: () => number;
        }>;
    }>;
}, {
    readonly client_id: Schema.brand<typeof Schema.String, "sync/clientId">;
    readonly current_clock: Schema.Struct<{
        vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
            default: () => {};
        }>;
        timestamp: Schema.optionalWith<typeof Schema.Number, {
            default: () => number;
        }>;
    }>;
    readonly last_synced_clock: Schema.Struct<{
        vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
            default: () => {};
        }>;
        timestamp: Schema.optionalWith<typeof Schema.Number, {
            default: () => number;
        }>;
    }>;
}, {
    readonly client_id: string & import("effect/Brand").Brand<"sync/clientId">;
} & {
    readonly current_clock: {
        readonly vector: {
            readonly [x: string]: number;
        };
        readonly timestamp: number;
    };
} & {
    readonly last_synced_clock: {
        readonly vector: {
            readonly [x: string]: number;
        };
        readonly timestamp: number;
    };
}, Schema.Struct.Encoded<{
    readonly client_id: Schema.brand<typeof Schema.String, "sync/clientId">;
    readonly current_clock: Schema.Struct<{
        vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
            default: () => {};
        }>;
        timestamp: Schema.optionalWith<typeof Schema.Number, {
            default: () => number;
        }>;
    }>;
    readonly last_synced_clock: Schema.Struct<{
        vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
            default: () => {};
        }>;
        timestamp: Schema.optionalWith<typeof Schema.Number, {
            default: () => number;
        }>;
    }>;
}>, never, {
    readonly client_id: string & import("effect/Brand").Brand<"sync/clientId">;
} & {
    readonly current_clock: {
        readonly vector: {
            readonly [x: string]: number;
        };
        readonly timestamp: number;
    };
} & {
    readonly last_synced_clock: {
        readonly vector: {
            readonly [x: string]: number;
        };
        readonly timestamp: number;
    };
}> & {
    readonly select: Schema.Struct<{
        readonly client_id: Schema.brand<typeof Schema.String, "sync/clientId">;
        readonly current_clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
        readonly last_synced_clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
    }>;
    readonly insert: Schema.Struct<{
        readonly client_id: Schema.brand<typeof Schema.String, "sync/clientId">;
        readonly current_clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
        readonly last_synced_clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
    }>;
    readonly update: Schema.Struct<{
        readonly client_id: Schema.brand<typeof Schema.String, "sync/clientId">;
        readonly current_clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
        readonly last_synced_clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
    }>;
    readonly json: Schema.Struct<{
        readonly client_id: Schema.brand<typeof Schema.String, "sync/clientId">;
        readonly current_clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
        readonly last_synced_clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
    }>;
    readonly jsonCreate: Schema.Struct<{
        readonly client_id: Schema.brand<typeof Schema.String, "sync/clientId">;
        readonly current_clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
        readonly last_synced_clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
    }>;
    readonly jsonUpdate: Schema.Struct<{
        readonly client_id: Schema.brand<typeof Schema.String, "sync/clientId">;
        readonly current_clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
        readonly last_synced_clock: Schema.Struct<{
            vector: Schema.optionalWith<Schema.Record$<typeof Schema.String, typeof Schema.Number>, {
                default: () => {};
            }>;
            timestamp: Schema.optionalWith<typeof Schema.Number, {
                default: () => number;
            }>;
        }>;
    }>;
};
export declare class ClientSyncStatusModel extends ClientSyncStatusModel_base {
}
declare const ActionModifiedRow_base: import("@effect/experimental/VariantSchema").Class<ActionModifiedRow, {
    readonly id: typeof Schema.String;
    readonly table_name: typeof Schema.String;
    readonly row_id: typeof Schema.String;
    readonly action_record_id: typeof Schema.String;
    readonly operation: Schema.Literal<["INSERT", "UPDATE", "DELETE"]>;
    readonly forward_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
    readonly reverse_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
    readonly sequence: typeof Schema.Number;
}, {
    readonly id: typeof Schema.String;
    readonly table_name: typeof Schema.String;
    readonly row_id: typeof Schema.String;
    readonly action_record_id: typeof Schema.String;
    readonly operation: Schema.Literal<["INSERT", "UPDATE", "DELETE"]>;
    readonly forward_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
    readonly reverse_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
    readonly sequence: typeof Schema.Number;
}, {
    readonly id: string;
} & {
    readonly operation: "INSERT" | "UPDATE" | "DELETE";
} & {
    readonly forward_patches: {
        readonly [x: string]: unknown;
    };
} & {
    readonly reverse_patches: {
        readonly [x: string]: unknown;
    };
} & {
    readonly table_name: string;
} & {
    readonly row_id: string;
} & {
    readonly action_record_id: string;
} & {
    readonly sequence: number;
}, Schema.Struct.Encoded<{
    readonly id: typeof Schema.String;
    readonly table_name: typeof Schema.String;
    readonly row_id: typeof Schema.String;
    readonly action_record_id: typeof Schema.String;
    readonly operation: Schema.Literal<["INSERT", "UPDATE", "DELETE"]>;
    readonly forward_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
    readonly reverse_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
    readonly sequence: typeof Schema.Number;
}>, never, {
    readonly id: string;
} & {
    readonly operation: "INSERT" | "UPDATE" | "DELETE";
} & {
    readonly forward_patches: {
        readonly [x: string]: unknown;
    };
} & {
    readonly reverse_patches: {
        readonly [x: string]: unknown;
    };
} & {
    readonly table_name: string;
} & {
    readonly row_id: string;
} & {
    readonly action_record_id: string;
} & {
    readonly sequence: number;
}> & {
    readonly select: Schema.Struct<{
        readonly id: typeof Schema.String;
        readonly table_name: typeof Schema.String;
        readonly row_id: typeof Schema.String;
        readonly action_record_id: typeof Schema.String;
        readonly operation: Schema.Literal<["INSERT", "UPDATE", "DELETE"]>;
        readonly forward_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
        readonly reverse_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
        readonly sequence: typeof Schema.Number;
    }>;
    readonly insert: Schema.Struct<{
        readonly id: typeof Schema.String;
        readonly table_name: typeof Schema.String;
        readonly row_id: typeof Schema.String;
        readonly action_record_id: typeof Schema.String;
        readonly operation: Schema.Literal<["INSERT", "UPDATE", "DELETE"]>;
        readonly forward_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
        readonly reverse_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
        readonly sequence: typeof Schema.Number;
    }>;
    readonly update: Schema.Struct<{
        readonly id: typeof Schema.String;
        readonly table_name: typeof Schema.String;
        readonly row_id: typeof Schema.String;
        readonly action_record_id: typeof Schema.String;
        readonly operation: Schema.Literal<["INSERT", "UPDATE", "DELETE"]>;
        readonly forward_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
        readonly reverse_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
        readonly sequence: typeof Schema.Number;
    }>;
    readonly json: Schema.Struct<{
        readonly id: typeof Schema.String;
        readonly table_name: typeof Schema.String;
        readonly row_id: typeof Schema.String;
        readonly action_record_id: typeof Schema.String;
        readonly operation: Schema.Literal<["INSERT", "UPDATE", "DELETE"]>;
        readonly forward_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
        readonly reverse_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
        readonly sequence: typeof Schema.Number;
    }>;
    readonly jsonCreate: Schema.Struct<{
        readonly id: typeof Schema.String;
        readonly table_name: typeof Schema.String;
        readonly row_id: typeof Schema.String;
        readonly action_record_id: typeof Schema.String;
        readonly operation: Schema.Literal<["INSERT", "UPDATE", "DELETE"]>;
        readonly forward_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
        readonly reverse_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
        readonly sequence: typeof Schema.Number;
    }>;
    readonly jsonUpdate: Schema.Struct<{
        readonly id: typeof Schema.String;
        readonly table_name: typeof Schema.String;
        readonly row_id: typeof Schema.String;
        readonly action_record_id: typeof Schema.String;
        readonly operation: Schema.Literal<["INSERT", "UPDATE", "DELETE"]>;
        readonly forward_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
        readonly reverse_patches: Schema.Record$<typeof Schema.String, typeof Schema.Unknown>;
        readonly sequence: typeof Schema.Number;
    }>;
};
/**
 * Model for tracking which rows were modified by which action
 */
export declare class ActionModifiedRow extends ActionModifiedRow_base {
}
export {};
//# sourceMappingURL=models.d.ts.map