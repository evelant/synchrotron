import { Data } from "effect"
import type { ActionRecord } from "@synchrotron/sync-core/models"

export class ServerConflictError extends Data.TaggedError("ServerConflictError")<{
	readonly message: string
	readonly conflictingActions: readonly ActionRecord[]
}> {}

export class ServerInternalError extends Data.TaggedError("ServerInternalError")<{
	readonly message: string
	readonly cause?: unknown
}> {}
