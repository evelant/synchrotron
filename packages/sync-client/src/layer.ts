import { Layer } from "effect"
import { PgLiteClientLive } from "./db/connection"
import {
	ActionModifiedRowRepo,
	ActionRecordRepo,
	ActionRegistry,
	ClockService,
	SyncService
} from "@synchrotron/sync-core"
import { SyncNetworkServiceLive } from "./SyncNetworkService"
import { KeyValueStore } from "@effect/platform"
import { initializeDatabaseSchema } from "@synchrotron/sync-core/db"

export const SynchrotronClientLive = SyncService.Default.pipe(
	Layer.provideMerge(SyncNetworkServiceLive),
	Layer.provideMerge(ActionRegistry.Default),
	Layer.provideMerge(ActionRecordRepo.Default),
	Layer.provideMerge(ActionModifiedRowRepo.Default),
	Layer.provideMerge(ClockService.Default),
	Layer.provideMerge(KeyValueStore.layerMemory),

	Layer.provideMerge(PgLiteClientLive)
)
