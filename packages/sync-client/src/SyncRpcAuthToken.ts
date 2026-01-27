import { Context, Effect, Layer, Option, Redacted } from "effect"
import { SynchrotronClientConfig } from "./config"

export interface SyncRpcAuthTokenService {
	readonly get: Effect.Effect<Option.Option<Redacted.Redacted>>
}

/**
 * Client-side auth token provider for the HTTP RPC transport.
 *
 * The default implementation reads a static token from `SynchrotronClientConfig.syncRpcAuthToken`,
 * but apps can provide a custom layer that fetches/refreshes tokens from their auth system.
 */
export class SyncRpcAuthToken extends Context.Tag("SyncRpcAuthToken")<
	SyncRpcAuthToken,
	SyncRpcAuthTokenService
>() {}

export const SyncRpcAuthTokenNone = Layer.succeed(
	SyncRpcAuthToken,
	SyncRpcAuthToken.of({ get: Effect.succeed(Option.none()) })
)

export const SyncRpcAuthTokenFromConfig = Layer.effect(
	SyncRpcAuthToken,
	Effect.gen(function* () {
		const config = yield* SynchrotronClientConfig
		const token =
			typeof config.syncRpcAuthToken === "string" && config.syncRpcAuthToken.length > 0
				? Option.some(Redacted.make(config.syncRpcAuthToken))
				: Option.none()
		return SyncRpcAuthToken.of({ get: Effect.succeed(token) })
	})
)

export const SyncRpcAuthTokenStatic = (token: string | Redacted.Redacted) =>
	Layer.succeed(
		SyncRpcAuthToken,
		SyncRpcAuthToken.of({
			get: Effect.succeed(Option.some(typeof token === "string" ? Redacted.make(token) : token))
		})
	)
