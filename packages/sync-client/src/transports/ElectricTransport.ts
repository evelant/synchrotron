import { Layer } from "effect"
import { type MakeSynchrotronClientLayerParams, makeSynchrotronClientLayer } from "../layer"
import { SyncNetworkServiceElectricLive } from "../SyncNetworkService"
import { ElectricSyncIngressLive, ElectricSyncService } from "../electric/ElectricSyncService"
import type { SynchrotronTransport } from "./Transport"

/**
 * Electric-based transport (push-ingress + RPC upload + server meta).
 *
 * This is a reference implementation of a `SyncIngress` transport:
 * - Electric provides action-log rows via Shape streams (ingress)
 * - RPC remains the upload path and is used for server meta (epoch/retention)
 *
 * IMPORTANT: in Electric mode, the RPC `fetchRemoteActions` implementation is `metaOnly` to avoid
 * “two ingress writers” (Electric is authoritative for remote action-log ingestion).
 */

export const ElectricIngressLive = ElectricSyncIngressLive.pipe(
	Layer.provideMerge(ElectricSyncService.Default)
)

export const ElectricTransport = {
	syncNetworkServiceLayer: SyncNetworkServiceElectricLive,
	syncIngressLayer: ElectricIngressLive
} as const satisfies SynchrotronTransport

/**
 * Convenience constructor for a PGlite client with Electric ingress enabled.
 *
 * Prefer using `ElectricTransport` + `makeSynchrotronClientLayer(...)` directly if you want to
 * customize composition.
 */
export const makeSynchrotronElectricClientLayer = (
	params: Omit<MakeSynchrotronClientLayerParams, "transport">
) =>
	makeSynchrotronClientLayer({
		...params,
		transport: ElectricTransport
	})
