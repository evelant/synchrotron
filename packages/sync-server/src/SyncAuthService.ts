import type { Headers } from "@effect/platform/Headers"
import { Config, Data, Effect, Layer, Option, Redacted } from "effect"
import { jwtVerify } from "jose"
import { SyncUserIdHeader, type UserId } from "./SyncUserId"

export class UnauthorizedError extends Data.TaggedError("UnauthorizedError")<{
	readonly message: string
	readonly cause?: unknown
}> {}

export interface JwtHs256Config {
	readonly secret: Redacted.Redacted
	readonly audience?: string
	readonly issuer?: string
	readonly userIdClaim?: string
}

const parseBearerToken = (authorization: string): string | null => {
	const parts = authorization.split(/\s+/).filter((p) => p.length > 0)
	const scheme = parts[0]
	const token = parts[1]
	if (!scheme || !token) return null
	if (scheme.toLowerCase() !== "bearer") return null
	return token
}

const getUserIdFromJwtPayload = (
	payload: Record<string, unknown> & { readonly sub?: unknown },
	claim: string
): string | null => {
	if (claim === "sub") return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null
	const value = payload[claim]
	return typeof value === "string" && value.length > 0 ? value : null
}

export const makeJwtHs256Auth = (config: JwtHs256Config) => {
	const secretBytes = new TextEncoder().encode(Redacted.value(config.secret))
	const userIdClaim = config.userIdClaim ?? "sub"

	return (headers: Headers) =>
		Effect.gen(function* () {
			const authorization = headers["authorization"]
			if (!authorization) {
				return yield* Effect.fail(
					new UnauthorizedError({ message: "Missing Authorization header (expected Bearer token)" })
				)
			}

			const token = parseBearerToken(authorization)
			if (!token) {
				return yield* Effect.fail(
					new UnauthorizedError({ message: "Invalid Authorization header (expected Bearer token)" })
				)
			}

			const verified = yield* Effect.tryPromise({
				try: () =>
					jwtVerify(token, secretBytes, {
						algorithms: ["HS256"],
						...(typeof config.audience === "string" ? { audience: config.audience } : {}),
						...(typeof config.issuer === "string" ? { issuer: config.issuer } : {})
					}),
				catch: (cause) => new UnauthorizedError({ message: "Invalid JWT", cause })
			})

			const payload = verified.payload as Record<string, unknown> & { readonly sub?: unknown }
			const userId = getUserIdFromJwtPayload(payload, userIdClaim)
			if (!userId) {
				return yield* Effect.fail(
					new UnauthorizedError({
						message: `JWT missing required user id claim: ${userIdClaim}`
					})
				)
			}

			return userId as UserId
		})
}

export const makeHeaderUserIdAuth = (headers: Headers) =>
	Effect.gen(function* () {
		const rawUserId = headers[SyncUserIdHeader]
		if (!rawUserId) {
			return yield* Effect.fail(
				new UnauthorizedError({ message: `Missing required header: ${SyncUserIdHeader}` })
			)
		}
		return rawUserId as UserId
	})

export class SyncAuthService extends Effect.Service<SyncAuthService>()("SyncAuthService", {
	effect: Effect.gen(function* () {
		const jwtSecret = yield* Config.redacted("SYNC_JWT_SECRET").pipe(Config.option)
		const gotrueJwtSecret = yield* Config.redacted("GOTRUE_JWT_SECRET").pipe(Config.option)
		const secret = Option.orElse(jwtSecret, () => gotrueJwtSecret)

		const jwtAudience = yield* Config.string("SYNC_JWT_AUD").pipe(Config.option)
		const gotrueJwtAudience = yield* Config.string("GOTRUE_JWT_AUD").pipe(Config.option)
		const audienceOption = Option.orElse(jwtAudience, () => gotrueJwtAudience)
		const issuerOption = yield* Config.string("SYNC_JWT_ISSUER").pipe(Config.option)
		const userIdClaim = yield* Config.string("SYNC_JWT_USER_ID_CLAIM").pipe(Config.withDefault("sub"))

		if (Option.isSome(secret)) {
			const jwtConfig: JwtHs256Config = {
				secret: secret.value,
				userIdClaim,
				...(Option.isSome(audienceOption) ? { audience: audienceOption.value } : {}),
				...(Option.isSome(issuerOption) ? { issuer: issuerOption.value } : {})
			}

			yield* Effect.logInfo("sync.auth.mode", {
				mode: "jwt-hs256",
				audience: Option.getOrNull(audienceOption),
				issuer: Option.getOrNull(issuerOption),
				userIdClaim
			})

			return {
				_tag: "SyncAuthService",
				requireUserId: makeJwtHs256Auth(jwtConfig)
			} as const
		}

			yield* Effect.logWarning("sync.auth.mode", {
				mode: "insecure-dev-header",
				message:
					"No JWT secret configured (SYNC_JWT_SECRET / GOTRUE_JWT_SECRET). Falling back to x-synchrotron-user-id header."
			})

			return { _tag: "SyncAuthService", requireUserId: makeHeaderUserIdAuth } as const
		})
	}) {}

export const SyncAuthServiceHeaderLive = Layer.succeed(
	SyncAuthService,
	SyncAuthService.of({
		_tag: "SyncAuthService",
		requireUserId: makeHeaderUserIdAuth
	})
)
