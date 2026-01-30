/**
 * SyncService "performSync" orchestrator.
 *
 * Coordinates the full sync loop:
 * - remote ingress + readiness checks (transport fetch + core-owned ingestion)
 * - case selection (remote-only / pending-only / reconcile / etc)
 * - upload gating (quarantine) and applied-cursor advancement
 *
 * Complex subroutines are split out to make the main flow readable:
 * - `SyncServicePerformSyncRemoteIngress` (fetch + ingest + apply-readiness checks)
 * - `SyncServicePerformSyncCases` (decision tree for sync strategies)
 * - `SyncServicePerformSyncAppliedCursor` (applied remote cursor computation)
 * - `SyncServicePerformSyncBootstrap` (optional bootstrap-from-snapshot for empty clients)
 * - `SyncServicePerformSyncQuarantine` (quarantine counters / upload gating)
 * - `SyncServicePerformSyncRecoveryPolicy` (policy for invalid/quarantine/discontinuity recovery)
 */
import type { SqlClient } from "@effect/sql"
import { Effect, Metric, Schedule } from "effect"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ClientClockState } from "../ClientClockState"
import type { ActionRecord } from "../models"
import * as SyncMetrics from "../observability/metrics"
import {
	FetchRemoteActionsCompacted,
	NetworkRequestError,
	RemoteActionFetchError,
	SendLocalActionsBehindHead,
	SendLocalActionsDenied,
	SendLocalActionsInternal,
	SendLocalActionsInvalid,
	SyncHistoryEpochMismatch,
	type SyncNetworkService
} from "../SyncNetworkService"
import { SyncError } from "../SyncServiceErrors"
import type { BootstrapSnapshot } from "./SyncServiceBootstrap"
import { makeAppliedRemoteCursor } from "./SyncServicePerformSyncAppliedCursor"
import { bootstrapFromSnapshotIfNeeded } from "./SyncServicePerformSyncBootstrap"
import { makePerformSyncCases } from "./SyncServicePerformSyncCases"
import { runSyncDoctor, SyncDoctorCorruption } from "./SyncServicePerformSyncDoctor"
import { getQuarantinedActionCount } from "./SyncServicePerformSyncQuarantine"
import {
	makePerformSyncRecoveryPolicy,
	type PerformSyncError,
	type PerformSyncResult
} from "./SyncServicePerformSyncRecoveryPolicy"
import { fetchIngestAndListRemoteActions } from "./SyncServicePerformSyncRemoteIngress"

export const makePerformSync = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly clockState: ClientClockState
	readonly actionRecordRepo: ActionRecordRepo
	readonly syncNetworkService: SyncNetworkService
	readonly clientId: string
	readonly newTraceId: Effect.Effect<string>
	readonly applyBootstrapSnapshot: (
		snapshot: BootstrapSnapshot
	) => Effect.Effect<void, unknown, never>
	readonly rollbackToAction: (targetActionId: string | null) => Effect.Effect<void, unknown, never>
	readonly rollbackToCommonAncestor: () => Effect.Effect<ActionRecord | null, unknown, never>
	readonly applyActionRecords: (
		remoteActions: readonly ActionRecord[]
	) => Effect.Effect<readonly ActionRecord[], unknown, never>
	readonly sendLocalActions: () => Effect.Effect<
		readonly ActionRecord[],
		| SendLocalActionsBehindHead
		| SendLocalActionsDenied
		| SendLocalActionsInvalid
		| SendLocalActionsInternal
		| NetworkRequestError
		| SyncError,
		never
	>
	readonly hardResync: () => Effect.Effect<void, unknown, never>
	readonly rebase: () => Effect.Effect<void, unknown, never>
	readonly quarantineUnsyncedActions: (
		failure: SendLocalActionsDenied | SendLocalActionsInvalid
	) => Effect.Effect<number, SyncError, never>
}) => {
	const {
		sqlClient,
		clockState,
		actionRecordRepo,
		syncNetworkService,
		clientId,
		newTraceId,
		applyBootstrapSnapshot,
		rollbackToAction,
		rollbackToCommonAncestor,
		applyActionRecords,
		sendLocalActions,
		hardResync,
		rebase,
		quarantineUnsyncedActions
	} = deps

	const { advanceAppliedRemoteServerIngestCursor } = makeAppliedRemoteCursor({
		sqlClient,
		clockState,
		clientId
	})

	/**
	 * synchronize with the server
	 * Fetches pending local actions and unseen remote actions, then determines the appropriate sync strategy:
	 * - Case 1: No local pending, apply remote actions.
	 * - Case 2: No remote actions, send local pending actions.
	 * - Case 3: Both local and remote actions exist, perform reconciliation.
	 * Returns the actions that were effectively processed (applied, sent, or reconciled).
	 */
	const performSync = () => performSyncWithPolicy(true, true)

	const performSyncWithPolicy = (
		allowInvalidRebase: boolean,
		allowDiscontinuityRecovery: boolean
	): Effect.Effect<PerformSyncResult, PerformSyncError, never> => {
		const recoveryPolicy = makePerformSyncRecoveryPolicy({
			sqlClient,
			actionRecordRepo,
			clientId,
			hardResync,
			rebase,
			quarantineUnsyncedActions,
			retryPerformSync: performSyncWithPolicy
		})

		return newTraceId
			.pipe(
				Effect.flatMap((syncSessionId) =>
					Effect.gen(function* () {
						yield* Effect.logInfo("performSync.start", { syncSessionId })
						const quarantinedCount = yield* getQuarantinedActionCount(sqlClient)
						const uploadsDisabled = quarantinedCount > 0
						yield* Metric.update(SyncMetrics.quarantinedActionsGauge, quarantinedCount)
						yield* Effect.annotateCurrentSpan({ uploadsDisabled, quarantinedCount })
						if (uploadsDisabled) {
							yield* Effect.logWarning("performSync.uploadsDisabled.quarantined", {
								syncSessionId,
								quarantinedCount
							})
						}
						// Ensure `client_sync_status` exists before reading cursor state (last_seen_server_ingest_id, etc).
						const lastSeenServerIngestIdBeforeBootstrap =
							yield* clockState.getLastSeenServerIngestId
						yield* Effect.logDebug("performSync.cursor.beforeBootstrap", {
							lastSeenServerIngestId: lastSeenServerIngestIdBeforeBootstrap
						})

						yield* bootstrapFromSnapshotIfNeeded({
							sqlClient,
							syncNetworkService,
							clientId,
							syncSessionId,
							lastSeenServerIngestIdBeforeBootstrap,
							applyBootstrapSnapshot
						})
						const lastSeenServerIngestIdAfterBootstrap = yield* clockState.getLastSeenServerIngestId
						yield* Effect.logDebug("performSync.cursor.afterBootstrap", {
							lastSeenServerIngestId: lastSeenServerIngestIdAfterBootstrap
						})

						yield* runSyncDoctor({
							sqlClient,
							clockState,
							actionRecordRepo,
							clientId,
							syncSessionId,
							advanceAppliedRemoteServerIngestCursor
						})

						const lastSeenServerIngestId = yield* clockState.getLastSeenServerIngestId
						yield* Effect.logDebug("performSync.cursor.afterDoctor", { lastSeenServerIngestId })
						// 1. Get pending local actions
						const pendingActions = uploadsDisabled
							? ([] as const)
							: yield* actionRecordRepo.findBySynced(false)
						yield* Metric.update(SyncMetrics.localUnsyncedActionsGauge, pendingActions.length)
						yield* Effect.annotateCurrentSpan({ pendingActionCount: pendingActions.length })
						yield* Effect.logDebug("performSync.pendingActions", {
							count: pendingActions.length,
							actions: pendingActions.map((a) => ({
								id: a.id,
								_tag: a._tag,
								client_id: a.client_id
							}))
						})

						const remoteReadiness = yield* fetchIngestAndListRemoteActions({
							sqlClient,
							clockState,
							actionRecordRepo,
							syncNetworkService,
							clientId,
							syncSessionId,
							lastSeenServerIngestId
						})
						if (remoteReadiness._tag === "RemoteNotReady") {
							return [] as const
						}
						yield* Effect.annotateCurrentSpan({
							remoteUnappliedActionCount: remoteReadiness.remoteActions.length
						})

						const { run } = makePerformSyncCases({
							sqlClient,
							clockState,
							actionRecordRepo,
							clientId,
							uploadsDisabled,
							rollbackToAction,
							rollbackToCommonAncestor,
							applyActionRecords,
							sendLocalActions,
							advanceAppliedRemoteServerIngestCursor
						})

						return yield* run(pendingActions, remoteReadiness.remoteActions)
					}).pipe(
						Effect.tapError((error) => {
							if (error instanceof SendLocalActionsBehindHead) {
								return Effect.all(
									[
										Effect.logWarning("performSync.behindHead", {
											syncSessionId,
											clientId,
											basisServerIngestId: error.basisServerIngestId,
											firstUnseenServerIngestId: error.firstUnseenServerIngestId,
											firstUnseenActionId: error.firstUnseenActionId ?? null
										}),
										Metric.increment(SyncMetrics.syncRetriesTotalFor("behind_head"))
									],
									{ concurrency: "unbounded", discard: true }
								)
							}
							const errorTag =
								typeof error === "object" && error !== null
									? ((error as { readonly _tag?: unknown })._tag ?? null)
									: null
							return Effect.logError("performSync.failed", {
								syncSessionId,
								clientId,
								errorTag: typeof errorTag === "string" ? errorTag : null,
								message: error instanceof Error ? error.message : String(error)
							})
						}),
						Effect.retry(
							Schedule.recurs(3).pipe(
								Schedule.whileInput((error) => error instanceof SendLocalActionsBehindHead)
							)
						),
						Effect.catchAll((error) => {
							if (
								error instanceof SendLocalActionsBehindHead ||
								error instanceof SendLocalActionsDenied ||
								error instanceof SendLocalActionsInvalid ||
								error instanceof SendLocalActionsInternal ||
								error instanceof NetworkRequestError ||
								error instanceof FetchRemoteActionsCompacted ||
								error instanceof RemoteActionFetchError ||
								error instanceof SyncHistoryEpochMismatch ||
								error instanceof SyncDoctorCorruption ||
								error instanceof SyncError
							) {
								return Effect.fail(error)
							}
							const message = error instanceof Error ? error.message : String(error)
							return Effect.fail(
								new SyncError({ message: `Sync failed: ${message}`, cause: error })
							)
						}),
						Effect.annotateLogs({ clientId, syncSessionId }),
						Effect.withSpan("SyncService.performSync", {
							attributes: { clientId, syncSessionId }
						})
					)
				)
			)
			.pipe(
				Effect.catchTag("SendLocalActionsDenied", recoveryPolicy.handleDenied),
				Effect.catchTag(
					"SendLocalActionsInvalid",
					recoveryPolicy.handleInvalid(allowInvalidRebase, allowDiscontinuityRecovery)
				),
				Effect.catchTag(
					"SyncHistoryEpochMismatch",
					recoveryPolicy.handleSyncHistoryEpochMismatch(
						allowInvalidRebase,
						allowDiscontinuityRecovery
					)
				),
				Effect.catchTag(
					"FetchRemoteActionsCompacted",
					recoveryPolicy.handleFetchRemoteActionsCompacted(
						allowInvalidRebase,
						allowDiscontinuityRecovery
					)
				),
				Effect.catchTag(
					"SyncDoctorCorruption",
					recoveryPolicy.handleSyncDoctorCorruption(allowInvalidRebase, allowDiscontinuityRecovery)
				)
			).pipe(
				Metric.trackDuration(SyncMetrics.syncDurationMs),
				Effect.tap(() => Metric.increment(SyncMetrics.syncAttemptsTotalFor("success"))),
				Effect.tapError(() => Metric.increment(SyncMetrics.syncAttemptsTotalFor("failure")))
			)
	}

	return { performSync } as const
}
