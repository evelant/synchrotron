import * as Headers from "@effect/platform/Headers"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect } from "effect"
import { SignJWT } from "jose"
import { SyncAuthService } from "../src/SyncAuthService"
import { SyncUserIdHeader } from "../src/SyncUserId"

const signHs256Jwt = (params: { readonly secret: string; readonly sub: string; readonly aud?: string }) =>
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

	it.effect("rejects missing Authorization when JWT is configured", () =>
		Effect.gen(function* () {
			const secret = "supersecretvalue-supersecretvalue"

				const error = yield* Effect.gen(function* () {
					const auth = yield* SyncAuthService
					return yield* auth.requireUserId(
						Headers.fromInput({
							[SyncUserIdHeader]: "userA"
						})
					)
				}).pipe(
					Effect.provide(SyncAuthService.Default),
					Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["SYNC_JWT_SECRET", secret]]))),
					Effect.flip
				)

			expect(error._tag).toBe("UnauthorizedError")
			expect(error.message).toContain("Missing Authorization")
		})
	)

	it.effect("falls back to dev user-id header when JWT is not configured", () =>
			Effect.gen(function* () {
				const userId = yield* Effect.gen(function* () {
					const auth = yield* SyncAuthService
					return yield* auth.requireUserId(
						Headers.fromInput({
							[SyncUserIdHeader]: "userA"
						})
					)
				}).pipe(
					Effect.provide(SyncAuthService.Default),
					Effect.withConfigProvider(ConfigProvider.fromMap(new Map()))
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
