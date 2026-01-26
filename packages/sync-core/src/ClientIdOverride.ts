import { Context } from "effect"

/**
 * Service tag for overriding the client ID in tests
 * This allows tests to specify a client ID without depending on a particular client identity implementation.
 */
export class ClientIdOverride extends Context.Tag("ClientIdOverride")<ClientIdOverride, string>() {}
