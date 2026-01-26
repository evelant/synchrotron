import type { Effect } from "effect"
import { Context } from "effect"
import type { ClientId } from "./models"

export interface ClientIdentityService {
	readonly get: Effect.Effect<ClientId>
}

/**
 * ClientIdentity provides the stable per-device client identifier used for HLC ordering and
 * action attribution.
 *
 * The implementation is runtime-specific (browser, React Native, tests) and is expected to live
 * outside `sync-core` so `sync-core` stays platform-agnostic.
 */
export class ClientIdentity extends Context.Tag("ClientIdentity")<
	ClientIdentity,
	ClientIdentityService
>() {}
