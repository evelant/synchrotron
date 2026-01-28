import { Schema } from "effect"

/**
 * Typed error for Electric ingress failures.
 *
 * Electric is a streaming transport; when we fail to decode/ingest a batch, we want a structured
 * error that can be logged and surfaced without relying on thrown exceptions.
 */
export class ElectricSyncError extends Schema.TaggedError<ElectricSyncError>()(
	"ElectricSyncError",
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown)
	}
) {}
