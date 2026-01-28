/**
 * Fetch a bootstrap snapshot and map transport-layer failures into a `SyncError`.
 *
 * Recovery paths treat snapshot fetch failures as unrecoverable for that attempt and want a
 * consistent error type for logging/propagation.
 */
import { Effect } from "effect"
import { SyncError } from "../SyncServiceErrors"
import type { SyncNetworkService } from "../SyncNetworkService"
import type { BootstrapSnapshot } from "./SyncServiceBootstrap"

export const fetchBootstrapSnapshotOrFail = (
	syncNetworkService: SyncNetworkService
): Effect.Effect<BootstrapSnapshot, SyncError, never> =>
	syncNetworkService.fetchBootstrapSnapshot().pipe(
		Effect.mapError(
			(error) =>
				new SyncError({
					message: error instanceof Error ? error.message : String(error),
					cause: error
				})
		)
	)
