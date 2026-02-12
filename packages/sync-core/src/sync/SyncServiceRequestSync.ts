import { Deferred, Effect, Ref } from "effect"

/**
 * `requestSync()` coordinator.
 *
 * Goal: coalesce many sync triggers into a single serialized `performSync()` loop.
 *
 * Semantics:
 * - multiple concurrent callers wait for the same “sync cycle” to become idle
 * - if additional requests arrive while a cycle is running, the cycle runs `performSync()` again
 * - `performSync()` is never run concurrently
 */
export const makeRequestSync = <A, E>(performSync: () => Effect.Effect<readonly A[], E, never>) =>
	Effect.gen(function* () {
		const mutex = yield* Effect.makeSemaphore(1)
		const needsSyncRef = yield* Ref.make(false)
		const cycleDeferredRef = yield* Ref.make<Deferred.Deferred<readonly A[], E> | null>(null)

		const runSyncCycle = (cycleDeferred: Deferred.Deferred<readonly A[], E>) => {
			const run = Effect.gen(function* () {
				const allResults: Array<A> = []

				while (true) {
					const shouldRun = yield* mutex.withPermits(1)(
						Effect.gen(function* () {
							const needsSync = yield* Ref.get(needsSyncRef)
							if (!needsSync) return false
							yield* Ref.set(needsSyncRef, false)
							return true
						})
					)

					if (!shouldRun) {
						// Clear the active-cycle marker before completing the deferred so that a fresh
						// request arriving at the boundary starts a new cycle rather than reusing a
						// just-completed one.
						yield* mutex.withPermits(1)(Ref.set(cycleDeferredRef, null))
						yield* Deferred.succeed(cycleDeferred, allResults)
						return
					}

					const result = yield* performSync()
					allResults.push(...result)
				}
			})

			return run.pipe(
				Effect.catchAll((error: E) =>
					// Same “clear first” rule as the success path: always allow a new cycle to be
					// started after a failure.
					mutex
						.withPermits(1)(Ref.set(cycleDeferredRef, null))
						.pipe(Effect.zipRight(Deferred.fail(cycleDeferred, error)), Effect.asVoid)
				)
			)
		}

		const requestSync = (): Effect.Effect<readonly A[], E, never> =>
			Effect.gen(function* () {
				const cycleDeferred = yield* mutex.withPermits(1)(
					Effect.gen(function* () {
						yield* Ref.set(needsSyncRef, true)

						const existing = yield* Ref.get(cycleDeferredRef)
						if (existing !== null) return existing

						const deferred = yield* Deferred.make<readonly A[], E>()
						yield* Ref.set(cycleDeferredRef, deferred)
						yield* Effect.forkDaemon(runSyncCycle(deferred))
						return deferred
					})
				)

				return yield* Deferred.await(cycleDeferred)
			})

		return { requestSync } as const
	})
