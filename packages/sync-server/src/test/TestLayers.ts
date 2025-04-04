import { PgClientLive } from "../db/connection"
import { SyncNetworkServiceServerLive } from "../SyncNetworkService"
import { Layer } from "effect"

/**
 * Provides the live PgClient layer for testing server-specific database interactions.
 * Note: This uses the live configuration (e.g., DATABASE_URL).
 * For isolated tests, consider providing a test-specific database layer.
 */
export const PgClientTestLayer = PgClientLive

/**
 * Provides the live (stub) server network service layer for testing.
 */
export const SyncNetworkServiceServerTestLayer = SyncNetworkServiceServerLive

/**
 * Combined layer for server-specific testing, providing both DB and network stubs.
 */
export const ServerTestLayer = Layer.merge(
  PgClientTestLayer,
  SyncNetworkServiceServerTestLayer
)

// Add other server-specific test layers or configurations as needed.