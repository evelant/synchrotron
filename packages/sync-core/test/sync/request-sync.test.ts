import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Ref } from "effect"
import { makeRequestSync } from "../../src/sync/SyncServiceRequestSync"

describe("SyncService.requestSync", () => {
	it.scoped("coalesces bursty triggers and never overlaps performSync", () =>
		Effect.gen(function* () {
			const activeCount = yield* Ref.make(0)
			const callCount = yield* Ref.make(0)

			const started1 = yield* Deferred.make<void, never>()
			const started2 = yield* Deferred.make<void, never>()

			const gate1 = yield* Deferred.make<void, never>()
			const gate2 = yield* Deferred.make<void, never>()

			const performSync = () =>
				Effect.gen(function* () {
					yield* Ref.update(activeCount, (n) => n + 1)
					const active = yield* Ref.get(activeCount)
					if (active > 1) {
						return yield* Effect.fail("performSync overlapped")
					}

					const index = yield* Ref.updateAndGet(callCount, (n) => n + 1)
					if (index === 1) {
						yield* Deferred.succeed(started1, undefined)
						yield* Deferred.await(gate1)
					} else if (index === 2) {
						yield* Deferred.succeed(started2, undefined)
						yield* Deferred.await(gate2)
					} else {
						return yield* Effect.fail(`unexpected performSync call: ${index}`)
					}

					return [index] as const
				}).pipe(Effect.ensuring(Ref.update(activeCount, (n) => n - 1)))

			const { requestSync } = yield* makeRequestSync<number, string>(performSync)

			const fiberA = yield* Effect.fork(requestSync())
			yield* Deferred.await(started1)

			// A second request while the first sync run is in-flight should not overlap, but should
			// cause exactly one additional run after the first completes.
			const fiberB = yield* Effect.fork(requestSync())

			yield* Deferred.succeed(gate1, undefined)
			yield* Deferred.await(started2)
			yield* Deferred.succeed(gate2, undefined)

			const resultA = yield* fiberA.await
			const resultB = yield* fiberB.await

			expect(resultA._tag).toBe("Success")
			if (resultA._tag === "Success") {
				expect(resultA.value).toEqual([1, 2])
			}
			expect(resultB._tag).toBe("Success")
			if (resultB._tag === "Success") {
				expect(resultB.value).toEqual([1, 2])
			}
			expect(yield* Ref.get(callCount)).toBe(2)
		})
	)

	it.scoped("allows a new cycle after the previous cycle becomes idle", () =>
		Effect.gen(function* () {
			const callCount = yield* Ref.make(0)

			const performSync = () =>
				Ref.updateAndGet(callCount, (n) => n + 1).pipe(Effect.map((n) => [n] as const))

			const { requestSync } = yield* makeRequestSync<number, never>(performSync)

			const first = yield* requestSync()
			const second = yield* requestSync()

			expect(first).toEqual([1])
			expect(second).toEqual([2])
			expect(yield* Ref.get(callCount)).toBe(2)
		})
	)

	it.scoped("clears internal state on failure so a subsequent request can retry", () =>
		Effect.gen(function* () {
			const callCount = yield* Ref.make(0)

			const performSync = () =>
				Effect.gen(function* () {
					const index = yield* Ref.updateAndGet(callCount, (n) => n + 1)
					if (index === 1) {
						return yield* Effect.fail("boom")
					}
					return [index] as const
				})

			const { requestSync } = yield* makeRequestSync<number, string>(performSync)

			const first = yield* Effect.either(requestSync())
			expect(first._tag).toBe("Left")
			if (first._tag === "Left") {
				expect(first.left).toBe("boom")
			}

			const second = yield* requestSync()
			expect(second).toEqual([2])
			expect(yield* Ref.get(callCount)).toBe(2)
		})
	)
})
