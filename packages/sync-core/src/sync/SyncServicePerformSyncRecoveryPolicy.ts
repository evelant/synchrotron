import type { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { ActionRecordRepo } from "../ActionRecordRepo"
import type { ActionRecord } from "../models"
import {
	FetchRemoteActionsCompacted,
	NetworkRequestError,
	RemoteActionFetchError,
	SendLocalActionsBehindHead,
	SendLocalActionsInternal,
	SyncHistoryEpochMismatch,
	type SendLocalActionsDenied,
	type SendLocalActionsInvalid
} from "../SyncNetworkService"
import { SyncError } from "../SyncServiceErrors"
import { getQuarantinedActionCount } from "./SyncServicePerformSyncQuarantine"
import { SyncDoctorCorruption } from "./SyncServicePerformSyncDoctor"

export type PerformSyncResult = readonly ActionRecord[]

export type PerformSyncError =
	| SendLocalActionsBehindHead
	| SendLocalActionsInternal
	| NetworkRequestError
	| FetchRemoteActionsCompacted
	| RemoteActionFetchError
	| SyncHistoryEpochMismatch
	| SyncDoctorCorruption
	| SyncError

const toPerformSyncError = (message: string, error: unknown): PerformSyncError => {
	if (
		error instanceof SendLocalActionsBehindHead ||
		error instanceof SendLocalActionsInternal ||
		error instanceof NetworkRequestError ||
		error instanceof RemoteActionFetchError ||
		error instanceof FetchRemoteActionsCompacted ||
		error instanceof SyncHistoryEpochMismatch ||
		error instanceof SyncDoctorCorruption ||
		error instanceof SyncError
	) {
		return error
	}
	return new SyncError({ message, cause: error })
}

/**
 * Recovery policy for `performSync`.
 *
 * `SyncServiceRecovery` implements the *mechanics* of hardResync/rebase; this policy decides *when*
 * to invoke them (and when to quarantine).
 */
export const makePerformSyncRecoveryPolicy = (deps: {
	readonly sqlClient: SqlClient.SqlClient
	readonly actionRecordRepo: ActionRecordRepo
	readonly clientId: string
	readonly hardResync: () => Effect.Effect<void, unknown, never>
	readonly rebase: () => Effect.Effect<void, unknown, never>
	readonly quarantineUnsyncedActions: (
		failure: SendLocalActionsDenied | SendLocalActionsInvalid
	) => Effect.Effect<number, SyncError, never>
	readonly retryPerformSync: (
		allowInvalidRebase: boolean,
		allowDiscontinuityRecovery: boolean
	) => Effect.Effect<PerformSyncResult, PerformSyncError, never>
}) => {
	const {
		sqlClient,
		actionRecordRepo,
		clientId,
		hardResync,
		rebase,
		quarantineUnsyncedActions,
		retryPerformSync
	} = deps

	const handleDenied = (error: SendLocalActionsDenied) =>
		quarantineUnsyncedActions(error).pipe(Effect.as([] as const))

	const handleInvalid = (allowInvalidRebase: boolean, allowDiscontinuityRecovery: boolean) => {
		return (
			error: SendLocalActionsInvalid
		): Effect.Effect<PerformSyncResult, PerformSyncError, never> => {
			if (!allowInvalidRebase) {
				return quarantineUnsyncedActions(error).pipe(Effect.as([] as const))
			}

			return Effect.logWarning("performSync.invalid.rebaseOnce", {
				clientId,
				message: error.message,
				code: error.code ?? null
			}).pipe(
				Effect.zipRight(
					rebase().pipe(
						Effect.catchAll((rebaseError) =>
							Effect.logError("performSync.invalid.rebaseFailed", {
								clientId,
								message: rebaseError instanceof Error ? rebaseError.message : String(rebaseError)
							}).pipe(Effect.asVoid)
						)
					)
				),
				Effect.zipRight(retryPerformSync(false, allowDiscontinuityRecovery))
			)
		}
	}

	const handleSyncHistoryEpochMismatch = (
		allowInvalidRebase: boolean,
		allowDiscontinuityRecovery: boolean
	) => {
		return (
			error: SyncHistoryEpochMismatch
		): Effect.Effect<PerformSyncResult, PerformSyncError, never> =>
			Effect.gen(function* () {
				const quarantinedCount = yield* getQuarantinedActionCount(sqlClient)
				if (quarantinedCount > 0) {
					return yield* Effect.fail(
						new SyncError({
							message:
								"Sync history changed while local actions are quarantined; app must resolve (discard or hard resync)",
							cause: error
						})
					)
				}

				if (!allowDiscontinuityRecovery) {
					return yield* Effect.fail(
						new SyncError({
							message:
								"Sync history epoch mismatch persists after recovery attempt; app must hard resync",
							cause: error
						})
					)
				}

				const pending = yield* actionRecordRepo.allUnsyncedActive()
				if (pending.length === 0) {
					yield* Effect.logWarning("performSync.epochMismatch.hardResync", {
						clientId,
						localEpoch: error.localEpoch,
						serverEpoch: error.serverEpoch
					})
					yield* hardResync()
				} else {
					yield* Effect.logWarning("performSync.epochMismatch.rebase", {
						clientId,
						pendingCount: pending.length,
						localEpoch: error.localEpoch,
						serverEpoch: error.serverEpoch
					})
					yield* rebase()
				}

				return yield* retryPerformSync(allowInvalidRebase, false)
			}).pipe(
				Effect.catchAll((unknownError) =>
					Effect.fail(toPerformSyncError("Failed while handling sync epoch mismatch", unknownError))
				)
			)
	}

	const handleFetchRemoteActionsCompacted = (
		allowInvalidRebase: boolean,
		allowDiscontinuityRecovery: boolean
	) => {
		return (
			error: FetchRemoteActionsCompacted
		): Effect.Effect<PerformSyncResult, PerformSyncError, never> =>
			Effect.gen(function* () {
				const quarantinedCount = yield* getQuarantinedActionCount(sqlClient)
				if (quarantinedCount > 0) {
					return yield* Effect.fail(
						new SyncError({
							message:
								"Server history was compacted while local actions are quarantined; app must resolve (discard or hard resync)",
							cause: error
						})
					)
				}

				if (!allowDiscontinuityRecovery) {
					return yield* Effect.fail(
						new SyncError({
							message:
								"Server history compaction requires resync; recovery attempt did not resolve it",
							cause: error
						})
					)
				}

				const pending = yield* actionRecordRepo.allUnsyncedActive()
				if (pending.length === 0) {
					yield* Effect.logWarning("performSync.historyCompacted.hardResync", {
						clientId,
						sinceServerIngestId: error.sinceServerIngestId,
						minRetainedServerIngestId: error.minRetainedServerIngestId
					})
					yield* hardResync()
				} else {
					yield* Effect.logWarning("performSync.historyCompacted.rebase", {
						clientId,
						pendingCount: pending.length,
						sinceServerIngestId: error.sinceServerIngestId,
						minRetainedServerIngestId: error.minRetainedServerIngestId
					})
					yield* rebase()
				}

				return yield* retryPerformSync(allowInvalidRebase, false)
			}).pipe(
				Effect.catchAll((unknownError) =>
					Effect.fail(
						toPerformSyncError("Failed while handling server history compaction", unknownError)
					)
				)
			)
	}

	const handleSyncDoctorCorruption = (
		allowInvalidRebase: boolean,
		allowDiscontinuityRecovery: boolean
	) => {
		return (
			error: SyncDoctorCorruption
		): Effect.Effect<PerformSyncResult, PerformSyncError, never> =>
			Effect.gen(function* () {
				const quarantinedCount = yield* getQuarantinedActionCount(sqlClient)
				if (quarantinedCount > 0) {
					return yield* Effect.fail(
						new SyncError({
							message:
								"Sync doctor detected corruption while local actions are quarantined; app must resolve (discard or hard resync)",
							cause: error
						})
					)
				}

				if (!allowDiscontinuityRecovery) {
					return yield* Effect.fail(
						new SyncError({
							message:
								"Sync doctor corruption persists after recovery attempt; app must hard resync",
							cause: error
						})
					)
				}

				const pending = yield* actionRecordRepo.allUnsyncedActive()
				if (pending.length === 0) {
					yield* Effect.logWarning("performSync.syncDoctor.hardResync", {
						clientId,
						lastSeenServerIngestId: error.lastSeenServerIngestId,
						firstUnappliedActionId: error.firstUnappliedActionId ?? null,
						firstUnappliedServerIngestId: error.firstUnappliedServerIngestId ?? null
					})
					yield* hardResync()
				} else {
					yield* Effect.logWarning("performSync.syncDoctor.rebase", {
						clientId,
						pendingCount: pending.length,
						lastSeenServerIngestId: error.lastSeenServerIngestId,
						firstUnappliedActionId: error.firstUnappliedActionId ?? null,
						firstUnappliedServerIngestId: error.firstUnappliedServerIngestId ?? null
					})
					yield* rebase()
				}

				return yield* retryPerformSync(allowInvalidRebase, false)
			}).pipe(
				Effect.catchAll((unknownError) =>
					Effect.fail(
						toPerformSyncError("Failed while handling sync doctor corruption", unknownError)
					)
				)
			)
	}

	return {
		handleDenied,
		handleInvalid,
		handleSyncHistoryEpochMismatch,
		handleFetchRemoteActionsCompacted,
		handleSyncDoctorCorruption
	} as const
}
