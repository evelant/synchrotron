import { Context, Schema } from "effect"

export const UserId = Schema.String.pipe(Schema.brand("synchrotron/userId"))
export type UserId = typeof UserId.Type

export class SyncUserId extends Context.Tag("SyncUserId")<SyncUserId, UserId>() {}
