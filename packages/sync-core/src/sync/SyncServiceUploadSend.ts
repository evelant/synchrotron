/**
 * Wraps the SyncNetworkService upload call with consistent spans + error logging.
 *
 * This keeps `SyncServiceUpload` focused on orchestration (what to send and what to do after).
 */
import { Effect, Metric } from "effect"
import type { ActionModifiedRow, ActionRecord } from "../models"
import * as SyncMetrics from "../observability/metrics"
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
				Metric.trackDuration(
					SyncMetrics.rpcDurationMsFor({ method: "SendLocalActions", side: "client" })
				),
				Effect.tap(() =>
					Metric.increment(
						SyncMetrics.rpcRequestsTotalFor({
							method: "SendLocalActions",
							side: "client",
							outcome: "success"
						})
					)
				),
				Effect.tap(() => Metric.incrementBy(SyncMetrics.actionsUploadedTotal, actionsToSend.length)),
				Effect.tap(() => Metric.incrementBy(SyncMetrics.amrsUploadedTotal, amrs.length)),
				Effect.tapError(() =>
					Metric.increment(
						SyncMetrics.rpcRequestsTotalFor({
							method: "SendLocalActions",
							side: "client",
							outcome: "error"
						})
					)
				),
				Effect.withSpan("SyncNetworkService.sendLocalActions", {
					kind: "client",
					attributes: {
						clientId,
						sendBatchId,
						actionCount: actionsToSend.length,
						amrCount: amrs.length,
						basisServerIngestId,
						"rpc.system": "synchrotron",
						"rpc.service": "SyncNetworkRpc",
						"rpc.method": "SendLocalActions"
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
