import { Context } from "effect"

/**
 * Service tag for overriding the client ID in tests
 * This allows tests to specify a client ID without modifying the ClockService interface
 */
export class ClientIdOverride extends Context.Tag("ClientIdOverride")<ClientIdOverride, string>() {}
