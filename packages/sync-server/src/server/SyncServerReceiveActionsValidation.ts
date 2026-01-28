import type { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"
import { SendLocalActionsInvalid } from "@synchrotron/sync-core/SyncNetworkService"
import { Effect } from "effect"
import { isJsonObject } from "../SyncServerServiceUtils"

export const validateReceiveActionsBatch = (deps: {
	readonly clientId: string
	readonly actions: readonly ActionRecord[]
	readonly amrs: readonly ActionModifiedRow[]
}) =>
	Effect.gen(function* () {
		const { clientId, actions, amrs } = deps

		const invalidClientIdActions = actions.filter((a) => a.client_id !== clientId)
		if (invalidClientIdActions.length > 0) {
			yield* Effect.logWarning("server.receiveActions.invalidClientId", {
				clientId,
				invalidActionCount: invalidClientIdActions.length,
				invalidActionIds: invalidClientIdActions.slice(0, 20).map((a) => a.id),
				invalidActionClientIds: Array.from(
					new Set(invalidClientIdActions.slice(0, 50).map((a) => a.client_id))
				)
			})
			return yield* Effect.fail(
				new SendLocalActionsInvalid({
					message: `Invalid upload: all actions must have client_id=${clientId}`
				})
			)
		}

		const actionIdSet = new Set(actions.map((a) => a.id))
		const invalidAmrs = amrs.filter((amr) => actionIdSet.has(amr.action_record_id) === false)
		if (invalidAmrs.length > 0) {
			yield* Effect.logWarning("server.receiveActions.invalidAmrBatch", {
				clientId,
				invalidAmrCount: invalidAmrs.length,
				invalidAmrIds: invalidAmrs.slice(0, 20).map((a) => a.id),
				invalidAmrActionRecordIds: Array.from(
					new Set(invalidAmrs.slice(0, 50).map((a) => a.action_record_id))
				)
			})
			return yield* Effect.fail(
				new SendLocalActionsInvalid({
					message: "Invalid upload: AMRs must reference actions in the same batch"
				})
			)
		}

		const invalidClockTypeCount = actions.filter((a) => isJsonObject(a.clock) === false).length
		const invalidArgsTypeCount = actions.filter((a) => isJsonObject(a.args) === false).length
		const invalidPatchTypeCount = amrs.filter(
			(a) => isJsonObject(a.forward_patches) === false || isJsonObject(a.reverse_patches) === false
		).length

		if (invalidClockTypeCount > 0 || invalidArgsTypeCount > 0 || invalidPatchTypeCount > 0) {
			yield* Effect.logWarning("server.receiveActions.invalidJsonTypes", {
				clientId,
				invalidClockTypeCount,
				invalidArgsTypeCount,
				invalidPatchTypeCount
			})
			return yield* Effect.fail(
				new SendLocalActionsInvalid({
					message:
						"Invalid upload: JSON fields must be decoded objects (not strings). Ensure RPC schemas use `.json` and do not double-encode JSON."
				})
			)
		}

		return
	})
