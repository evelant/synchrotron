import type { SyncIngress, SyncNetworkService } from "@synchrotron/sync-core"
import type { Layer } from "effect"

/**
 * Standard "transport" shape for Synchrotron clients.
 *
 * A transport is:
 * - a required `SyncNetworkService` implementation (egress + optional pull-ingress)
 * - an optional `SyncIngress` implementation (push/notify/hybrid ingress)
 *
 * Notes:
 * - When used with `makeSynchrotronClientLayer({ transport: ... })`, providing `syncIngressLayer`
 *   enables the core-owned ingress runner automatically (schema init + ingestion + `requestSync()` triggers).
 * - Transports should not write directly to `action_records` / `action_modified_rows`.
 */
export type SynchrotronTransport<
	RNetwork = unknown,
	ENetwork = unknown,
	RIngress = unknown,
	EIngress = unknown
> = Readonly<{
	readonly syncNetworkServiceLayer: Layer.Layer<SyncNetworkService, ENetwork, RNetwork>
	readonly syncIngressLayer?: Layer.Layer<SyncIngress, EIngress, RIngress> | undefined
}>
