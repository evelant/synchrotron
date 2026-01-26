import { ActionRecordRepo, SyncService } from "@synchrotron/sync-core"
import { ElectricSyncService } from "@synchrotron/sync-client/electric/ElectricSyncService"
import { Effect } from "effect"
import { useCallback, useEffect } from "react"
import { useRuntime } from "../runtime"

export function useSyncedActions(onActionsApplied?: () => void) {
	const runtime = useRuntime()

	const applySyncedButUnappliedActions = useCallback(() => {
		const applyActionsEffect = Effect.gen(function* () {
			const actionRecordRepo = yield* ActionRecordRepo
			const syncService = yield* SyncService
			const electricSyncService = yield* ElectricSyncService

			const isElectricSynced = yield* electricSyncService.isFullySynced()
			if (!isElectricSynced) return false

			const syncedButUnappliedActions = yield* actionRecordRepo.findSyncedButUnapplied()
			if (syncedButUnappliedActions.length === 0) return false

			yield* Effect.logInfo("todoAppWeb.applySyncedButUnapplied.start", {
				count: syncedButUnappliedActions.length
			})
			yield* syncService.applyActionRecords(syncedButUnappliedActions)
			return true
		})

		return runtime
			.runPromise(applyActionsEffect)
			.then((actionsApplied) => {
				if (actionsApplied) onActionsApplied?.()
			})
			.catch((err) => {
				const errorString = String(err)
				// Ignore duplicate key errors as they're expected during sync conflicts
				if (
					errorString.includes("duplicate key value") ||
					errorString.includes("unique constraint")
				) {
					console.warn("Sync conflict detected - continuing with local state")
				} else {
					console.error("Failed to apply synced actions:", err)
				}
			})
	}, [runtime, onActionsApplied])

	useEffect(() => {
		void applySyncedButUnappliedActions()

		const interval = setInterval(() => {
			void applySyncedButUnappliedActions()
		}, 5000)

		return () => clearInterval(interval)
	}, [applySyncedButUnappliedActions])

	return {
		checkForUnappliedActions: applySyncedButUnappliedActions
	}
}
