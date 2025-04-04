import { PgLiteClientLive } from "../db/connection"
import { SyncNetworkServiceClientLive } from "../SyncNetworkService"
import { Layer } from "effect"

/**
 * Provides the live PGLite client layer for testing client-specific database interactions.
 */
export const PgliteClientTestLayer = PgLiteClientLive

/**
 * Provides the live (stub) client network service layer for testing.
 */
export const SyncNetworkServiceClientTestLayer = SyncNetworkServiceClientLive

/**
 * Combined layer for client-specific testing, providing both DB and network stubs.
 */
export const ClientTestLayer = Layer.merge(
  PgliteClientTestLayer,
  SyncNetworkServiceClientTestLayer
)

// Add other client-specific test layers or configurations as needed.