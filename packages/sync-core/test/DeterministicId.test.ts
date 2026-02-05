import { describe, it } from "@effect/vitest"
import {
	DeterministicId,
	DeterministicIdIdentityConfig
} from "@synchrotron/sync-core/DeterministicId"
import { Effect, Layer } from "effect"
import { expect } from "vitest"

describe("DeterministicId", () => {
	it.scoped("generates stable IDs within an action", () =>
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

			expect(id1).toBe(id2)
			expect(id1).not.toBe(id3)

			const [id1b, id2b, id3b] = yield* deterministicId.withActionContext(actionId, program)
			expect([id1b, id2b, id3b]).toEqual([id1, id2, id3])
		}).pipe(
			Effect.provide(
				DeterministicId.Default.pipe(
					Layer.provide(
						Layer.succeed(DeterministicIdIdentityConfig, {
							identityByTable: {
								notes: (row) => row
							}
						})
					)
				)
			)
		)
	)

	it.scoped("fails when called without an action context", () =>
		Effect.gen(function* () {
			const deterministicId = yield* DeterministicId
			const result = yield* Effect.either(deterministicId.forRow("notes", { title: "A" }))
			expect(result._tag).toBe("Left")
		}).pipe(
			Effect.provide(
				DeterministicId.Default.pipe(
					Layer.provide(
						Layer.succeed(DeterministicIdIdentityConfig, {
							identityByTable: {
								notes: (row) => row
							}
						})
					)
				)
			)
		)
	)
})

describe("DeterministicId identity config (TODO 0019)", () => {
	it.scoped("uses configured identity columns instead of full row content", () =>
		Effect.gen(function* () {
			const deterministicId = yield* DeterministicId
			const actionId = "550e8400-e29b-41d4-a716-446655440000"

			const id1 = yield* deterministicId.withActionContext(
				actionId,
				deterministicId.forRow("notes", {
					audience_key: "audienceA",
					note_key: "noteA",
					title: "Title A"
				})
			)

			// Different non-identity content should not change the ID.
			const id2 = yield* deterministicId.withActionContext(
				actionId,
				deterministicId.forRow("notes", {
					audience_key: "audienceA",
					note_key: "noteA",
					title: "Title B"
				})
			)

			expect(id1).toBe(id2)
		}).pipe(
			Effect.provide(
				DeterministicId.Default.pipe(
					Layer.provide(
						Layer.succeed(DeterministicIdIdentityConfig, {
							identityByTable: {
								notes: ["audience_key", "note_key"]
							}
						})
					)
				)
			)
		)
	)

	it.scoped("fails when the table has no identity strategy", () =>
		Effect.gen(function* () {
			const deterministicId = yield* DeterministicId
			const actionId = "550e8400-e29b-41d4-a716-446655440000"

			const result = yield* Effect.either(
				deterministicId.withActionContext(
					actionId,
					deterministicId.forRow("unconfigured_table", { foo: "bar" })
				)
			)

			expect(result._tag).toBe("Left")
		}).pipe(
			Effect.provide(
				DeterministicId.Default.pipe(
					Layer.provide(
						Layer.succeed(DeterministicIdIdentityConfig, {
							identityByTable: {
								notes: (row) => row
							}
						})
					)
				)
			)
		)
	)

	it.scoped("fails when an identity column is missing", () =>
		Effect.gen(function* () {
			const deterministicId = yield* DeterministicId
			const actionId = "550e8400-e29b-41d4-a716-446655440000"

			const result = yield* Effect.either(
				deterministicId.withActionContext(
					actionId,
					deterministicId.forRow("notes", { audience_key: "audienceA" })
				)
			)

			expect(result._tag).toBe("Left")
		}).pipe(
			Effect.provide(
				DeterministicId.Default.pipe(
					Layer.provide(
						Layer.succeed(DeterministicIdIdentityConfig, {
							identityByTable: {
								notes: ["audience_key", "note_key"]
							}
						})
					)
				)
			)
		)
	)
})
