import { describe, it } from "@effect/vitest"
import { DeterministicId } from "@synchrotron/sync-core/DeterministicId"
import { Effect } from "effect"
import { expect } from "vitest"

describe("DeterministicId", () => {
	it.scoped(
		"generates stable IDs within an action and disambiguates collisions",
		() =>
			Effect.gen(function* () {
				const deterministicId = yield* DeterministicId

				const actionId = "550e8400-e29b-41d4-a716-446655440000"
				const row = { title: "A", content: "B" }

				const program = Effect.gen(function* () {
					const id1 = yield* deterministicId.forRow("notes", row)
					const id2 = yield* deterministicId.forRow("notes", row)
					const id3 = yield* deterministicId.forRow("notes", { ...row, content: "C" })
					return [id1, id2, id3] as const
				})

				const [id1, id2, id3] = yield* deterministicId.withActionContext(actionId, program)

				expect(id1).not.toBe(id2)
				expect(id1).not.toBe(id3)
				expect(id2).not.toBe(id3)

				const [id1b, id2b, id3b] = yield* deterministicId.withActionContext(actionId, program)
				expect([id1b, id2b, id3b]).toEqual([id1, id2, id3])
			}).pipe(Effect.provide(DeterministicId.Default))
	)

	it.scoped(
		"fails when called without an action context",
		() =>
			Effect.gen(function* () {
				const deterministicId = yield* DeterministicId
				const result = yield* Effect.either(deterministicId.forRow("notes", { title: "A" }))
				expect(result._tag).toBe("Left")
			}).pipe(Effect.provide(DeterministicId.Default))
	)
})
