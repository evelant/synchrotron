/**
 * Wraps the SyncNetworkService upload call with consistent spans + error logging.
 *
 * This keeps `SyncServiceUpload` focused on orchestration (what to send and what to do after).
 */
import { Effect } from "effect"
import type { ActionModifiedRow, ActionRecord } from "../models"
import type { SyncNetworkService } from "../SyncNetworkService"

export const sendUploadBatch = (args: {
	readonly syncNetworkService: SyncNetworkService
	readonly clientId: string
	readonly sendBatchId: string
	readonly basisServerIngestId: number
	readonly actionsToSend: readonly ActionRecord[]
	readonly amrs: readonly ActionModifiedRow[]
	readonly actionTags: Readonly<Record<string, number>>
}) =>
	Effect.gen(function* () {
		const {
			syncNetworkService,
			clientId,
			sendBatchId,
			basisServerIngestId,
			actionsToSend,
			amrs,
			actionTags
		} = args

		yield* syncNetworkService
			.sendLocalActions(
				actionsToSend as ReadonlyArray<ActionRecord>,
				amrs as ReadonlyArray<ActionModifiedRow>,
				basisServerIngestId
			)
			.pipe(
				Effect.withSpan("SyncNetworkService.sendLocalActions", {
					attributes: {
						clientId,
						sendBatchId,
						actionCount: actionsToSend.length,
						amrCount: amrs.length
					}
				}),
				Effect.tapError((error) => {
					const errorTag =
						typeof error === "object" && error !== null
							? ((error as { readonly _tag?: unknown })._tag ?? null)
							: null
					return Effect.logError("sendLocalActions.sendFailed", {
						sendBatchId,
						actionCount: actionsToSend.length,
						amrCount: amrs.length,
						actionTags,
						errorTag: typeof errorTag === "string" ? errorTag : null,
						errorMessage: error instanceof Error ? error.message : String(error)
					})
				})
			)
	})
