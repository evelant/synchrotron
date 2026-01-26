import * as Headers from "@effect/platform/Headers"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect } from "effect"
import { SignJWT, exportJWK, generateKeyPair } from "jose"
import { SyncAuthService } from "../src/SyncAuthService"

const signHs256Jwt = (params: {
	readonly secret: string
	readonly sub: string
	readonly aud?: string
}) =>
	new SignJWT({ role: "authenticated" })
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(params.sub)
		.setAudience(params.aud ?? "authenticated")
		.setIssuedAt()
		.setExpirationTime("2h")
		.sign(new TextEncoder().encode(params.secret))

describe("SyncAuthService (JWT)", () => {
	it.effect("derives user_id from JWT sub (HS256)", () =>
		Effect.gen(function* () {
			const secret = "supersecretvalue-supersecretvalue"
			const token = yield* Effect.promise(() =>
				signHs256Jwt({ secret, sub: "userA", aud: "authenticated" })
			)

			const userId = yield* Effect.gen(function* () {
				const auth = yield* SyncAuthService
				return yield* auth.requireUserId(
					Headers.fromInput({
						authorization: `Bearer ${token}`
					})
				)
			}).pipe(
				Effect.provide(SyncAuthService.Default),
				Effect.withConfigProvider(
					ConfigProvider.fromMap(
						new Map([
							["SYNC_JWT_SECRET", secret],
							["SYNC_JWT_AUD", "authenticated"]
						])
					)
				)
			)

			expect(userId).toBe("userA")
		})
	)

	it.effect("rejects missing Authorization header", () =>
		Effect.gen(function* () {
			const secret = "supersecretvalue-supersecretvalue"

			const error = yield* Effect.gen(function* () {
				const auth = yield* SyncAuthService
				return yield* auth.requireUserId(Headers.fromInput({}))
			}).pipe(
				Effect.provide(SyncAuthService.Default),
				Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["SYNC_JWT_SECRET", secret]]))),
				Effect.flip
			)

			expect(error._tag).toBe("UnauthorizedError")
			expect(error.message).toContain("Missing Authorization")
		})
	)

	it.effect("derives user_id from JWT sub (JWKS / RS256)", () =>
		Effect.gen(function* () {
			const jwksUrl = "https://synchrotron.test/.well-known/jwks.json"

			const keyPair = yield* Effect.promise(() => generateKeyPair("RS256"))
			const publicJwk = yield* Effect.promise(() => exportJWK(keyPair.publicKey))
			const kid = "synchrotron-test-kid"
			const jwks = {
				keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }]
			}

			const token = yield* Effect.promise(() =>
				new SignJWT({ role: "authenticated" })
					.setProtectedHeader({ alg: "RS256", kid })
					.setSubject("userA")
					.setAudience("authenticated")
					.setIssuedAt()
					.setExpirationTime("2h")
					.sign(keyPair.privateKey)
			)

			const userId = yield* Effect.acquireUseRelease(
				Effect.sync(() => {
					const originalFetch = globalThis.fetch
					;(globalThis as any).fetch = (input: any, init?: any) => {
						const request = input instanceof Request ? input : new Request(input, init)
						if (request.url === jwksUrl) {
							return Promise.resolve(
								new Response(JSON.stringify(jwks), {
									status: 200,
									headers: { "content-type": "application/json" }
								})
							)
						}
						return originalFetch(input as any, init)
					}
					return originalFetch
				}),
				() =>
					Effect.gen(function* () {
						const auth = yield* SyncAuthService
						return yield* auth.requireUserId(
							Headers.fromInput({
								authorization: `Bearer ${token}`
							})
						)
					}).pipe(
						Effect.provide(SyncAuthService.Default),
						Effect.withConfigProvider(
							ConfigProvider.fromMap(
								new Map([
									["SYNC_JWT_JWKS_URL", jwksUrl],
									["SYNC_JWT_AUD", "authenticated"]
								])
							)
						)
					),
				(originalFetch) =>
					Effect.sync(() => {
						;(globalThis as any).fetch = originalFetch
					})
			)

			expect(userId).toBe("userA")
		})
	)

	it.effect("rejects invalid JWT signature", () =>
		Effect.gen(function* () {
			const secret = "supersecretvalue-supersecretvalue"
			const token = yield* Effect.promise(() =>
				signHs256Jwt({ secret: "wrong-secret-wrong-secret-wrong", sub: "userA" })
			)

			const error = yield* Effect.gen(function* () {
				const auth = yield* SyncAuthService
				return yield* auth.requireUserId(
					Headers.fromInput({
						authorization: `Bearer ${token}`
					})
				)
			}).pipe(
				Effect.provide(SyncAuthService.Default),
				Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["SYNC_JWT_SECRET", secret]]))),
				Effect.flip
			)

			expect(error._tag).toBe("UnauthorizedError")
			expect(error.message).toContain("Invalid JWT")
		})
	)
})
