/**
 * Synchrotron domain metrics.
 *
 * These are Effect `Metric`s. They are cheap to record and become useful once an exporter is
 * installed (e.g. `@effect/opentelemetry/OtlpMetrics` via `@synchrotron/observability`).
 *
 * Metric names are Prometheus-friendly `snake_case`.
 */

import { Metric } from "effect"
import type * as Duration from "effect/Duration"
import type * as MetricT from "effect/Metric"

export type RpcMethod = "FetchRemoteActions" | "SendLocalActions" | "FetchBootstrapSnapshot"
export type RpcSide = "client" | "server"
export type Outcome = "success" | "error"
export type RpcFailureReason =
	| "network"
	| "behind_head"
	| "denied"
	| "invalid"
	| "internal"
	| "compacted"
	| "remote_fetch_error"
	| "unknown"

export const rpcRequestsTotal = Metric.counter("synchrotron_rpc_requests_total", {
	description: "Total number of Synchrotron RPC calls.",
	incremental: true
})

export const rpcRequestsTotalFor = (args: {
	readonly method: RpcMethod
	readonly side: RpcSide
	readonly outcome: Outcome
}): MetricT.Metric.Counter<number> =>
	rpcRequestsTotal.pipe(
		Metric.tagged("rpc_method", args.method),
		Metric.tagged("rpc_side", args.side),
		Metric.tagged("result", args.outcome)
	)

export const rpcFailuresTotal = Metric.counter("synchrotron_rpc_failures_total", {
	description: "Total number of failed Synchrotron RPC calls (low-cardinality reasons).",
	incremental: true
})

export const rpcFailuresTotalFor = (args: {
	readonly method: RpcMethod
	readonly side: RpcSide
	readonly reason: RpcFailureReason
}): MetricT.Metric.Counter<number> =>
	rpcFailuresTotal.pipe(
		Metric.tagged("rpc_method", args.method),
		Metric.tagged("rpc_side", args.side),
		Metric.tagged("reason", args.reason)
	)

export const rpcDurationMs = Metric.timer(
	"synchrotron_rpc_duration_ms",
	"Duration of Synchrotron RPC calls."
)

export const rpcDurationMsFor = (args: {
	readonly method: RpcMethod
	readonly side: RpcSide
}): MetricT.Metric.Histogram<Duration.Duration> =>
	rpcDurationMs.pipe(Metric.tagged("rpc_method", args.method), Metric.tagged("rpc_side", args.side))

export const syncAttemptsTotal = Metric.counter("synchrotron_sync_attempts_total", {
	description: "Total number of `SyncService.performSync` attempts.",
	incremental: true
})

export const syncAttemptsTotalFor = (
	result: "success" | "failure"
): MetricT.Metric.Counter<number> => syncAttemptsTotal.pipe(Metric.tagged("result", result))

export const syncDurationMs = Metric.timer(
	"synchrotron_sync_duration_ms",
	"Duration of `SyncService.performSync`."
)

export const syncRetriesTotal = Metric.counter("synchrotron_sync_retries_total", {
	description: "Total number of retried sync attempts (within a performSync call).",
	incremental: true
})

export const syncRetriesTotalFor = (
	reason: "behind_head" | "other"
): MetricT.Metric.Counter<number> => syncRetriesTotal.pipe(Metric.tagged("reason", reason))

export type SyncCase =
	| "noop"
	| "remote_only_fast_forward"
	| "remote_only_rematerialize"
	| "pending_only"
	| "apply_remote_then_send_pending"
	| "reconcile_then_send_pending"

export const syncCaseTotal = Metric.counter("synchrotron_sync_case_total", {
	description: "Total number of sync case selections.",
	incremental: true
})

export const syncCaseTotalFor = (caseName: SyncCase): MetricT.Metric.Counter<number> =>
	syncCaseTotal.pipe(Metric.tagged("case", caseName))

export const actionsDownloadedTotal = Metric.counter("synchrotron_actions_downloaded_total", {
	description: "Total number of action records downloaded by clients.",
	incremental: true
})

export const amrsDownloadedTotal = Metric.counter("synchrotron_amrs_downloaded_total", {
	description: "Total number of action_modified_rows downloaded by clients.",
	incremental: true
})

export const actionsUploadedTotal = Metric.counter("synchrotron_actions_uploaded_total", {
	description: "Total number of action records uploaded by clients.",
	incremental: true
})

export const amrsUploadedTotal = Metric.counter("synchrotron_amrs_uploaded_total", {
	description: "Total number of action_modified_rows uploaded by clients.",
	incremental: true
})

export const actionsAppliedTotal = Metric.counter("synchrotron_actions_applied_total", {
	description: "Total number of action records applied by clients.",
	incremental: true
})

export const actionsAppliedTotalFor = (
	source: "remote" | "replay"
): MetricT.Metric.Counter<number> => actionsAppliedTotal.pipe(Metric.tagged("source", source))

export const applyBatchDurationMs = Metric.timer(
	"synchrotron_apply_batch_duration_ms",
	"Duration of applying a remote action batch."
)

export const correctionDeltasTotal = Metric.counter("synchrotron_correction_deltas_total", {
	description: "Total number of detected CORRECTION deltas.",
	incremental: true
})

export const correctionDeltasTotalFor = (
	severity: "missing_only" | "overwrite"
): MetricT.Metric.Counter<number> => correctionDeltasTotal.pipe(Metric.tagged("severity", severity))

export const localUnsyncedActionsGauge = Metric.gauge("synchrotron_local_unsynced_actions", {
	description: "Current count of unsynced local actions (observed during a sync loop)."
})

export const remoteUnappliedActionsGauge = Metric.gauge("synchrotron_remote_unapplied_actions", {
	description:
		"Current count of ingested-but-unapplied remote actions (observed during a sync loop)."
})

export const quarantinedActionsGauge = Metric.gauge("synchrotron_quarantined_actions", {
	description: "Current count of quarantined (upload-gated) local actions."
})

export const remoteNotReadyTotal = Metric.counter("synchrotron_remote_not_ready_total", {
	description:
		"Total number of times remote ingress reported not-ready (typically due to incomplete patch ingestion).",
	incremental: true
})

export const remoteNotReadyTotalFor = (
	reason: "missing_patches" | "other"
): MetricT.Metric.Counter<number> => remoteNotReadyTotal.pipe(Metric.tagged("reason", reason))

export const bootstrapEmptyTotal = Metric.counter("synchrotron_bootstrap_empty_total", {
	description: "Total number of times a client bootstrapped from a server snapshot (empty client).",
	incremental: true
})

export const hardResyncTotal = Metric.counter("synchrotron_hard_resync_total", {
	description: "Total number of hard resync operations (snapshot reset).",
	incremental: true
})

export const hardResyncDurationMs = Metric.timer(
	"synchrotron_hard_resync_duration_ms",
	"Duration of `SyncService.hardResync`."
)

export const rebaseTotal = Metric.counter("synchrotron_rebase_total", {
	description: "Total number of rebase operations (snapshot reset + replay pending local actions).",
	incremental: true
})

export const rebaseDurationMs = Metric.timer(
	"synchrotron_rebase_duration_ms",
	"Duration of `SyncService.rebase`."
)

// Backwards-compat: old name, new metric.
export const bootstrapSnapshotsAppliedTotal = bootstrapEmptyTotal

export const serverActionsServedTotal = Metric.counter("synchrotron_server_actions_served_total", {
	description: "Total number of action records served by the sync server.",
	incremental: true
})

export const serverActionsServedTotalFor = (
	method: "FetchRemoteActions" | "FetchBootstrapSnapshot"
): MetricT.Metric.Counter<number> =>
	serverActionsServedTotal.pipe(Metric.tagged("rpc_method", method))

export const serverAmrsServedTotal = Metric.counter("synchrotron_server_amrs_served_total", {
	description: "Total number of action_modified_rows served by the sync server.",
	incremental: true
})

export const serverAmrsServedTotalFor = (
	method: "FetchRemoteActions" | "FetchBootstrapSnapshot"
): MetricT.Metric.Counter<number> => serverAmrsServedTotal.pipe(Metric.tagged("rpc_method", method))

export const serverActionsReceivedTotal = Metric.counter(
	"synchrotron_server_actions_received_total",
	{
		description: "Total number of action records received by the sync server.",
		incremental: true
	}
)

export const serverActionsReceivedTotalFor = (
	method: "SendLocalActions"
): MetricT.Metric.Counter<number> =>
	serverActionsReceivedTotal.pipe(Metric.tagged("rpc_method", method))

export const serverAmrsReceivedTotal = Metric.counter("synchrotron_server_amrs_received_total", {
	description: "Total number of action_modified_rows received by the sync server.",
	incremental: true
})

export const serverAmrsReceivedTotalFor = (
	method: "SendLocalActions"
): MetricT.Metric.Counter<number> =>
	serverAmrsReceivedTotal.pipe(Metric.tagged("rpc_method", method))

const getErrorTag = (error: unknown): string | null =>
	typeof error === "object" && error !== null
		? typeof (error as { readonly _tag?: unknown })._tag === "string"
			? (error as { readonly _tag: string })._tag
			: null
		: null

export const rpcFailureReasonFromError = (error: unknown): RpcFailureReason => {
	const tag = getErrorTag(error)
	switch (tag) {
		case "NetworkRequestError":
			return "network"
		case "SendLocalActionsBehindHead":
			return "behind_head"
		case "SendLocalActionsDenied":
			return "denied"
		case "SendLocalActionsInvalid":
			return "invalid"
		case "SendLocalActionsInternal":
		case "ServerInternalError":
			return "internal"
		case "FetchRemoteActionsCompacted":
			return "compacted"
		case "RemoteActionFetchError":
			return "remote_fetch_error"
		default:
			return "unknown"
	}
}
