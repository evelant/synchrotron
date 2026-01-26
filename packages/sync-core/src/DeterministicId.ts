import { Effect, FiberRef, Schema } from "effect"
import { NIL, validate as validateUuid, v5 as uuidv5 } from "uuid"

export class DeterministicIdError extends Schema.TaggedError<DeterministicIdError>()(
	"DeterministicIdError",
	{
		message: Schema.String
	}
) {}

type State = Readonly<{
	actionId: string | null
	collisionByKey: ReadonlyMap<string, number>
}>

const normalizeForJson = (value: unknown): unknown => {
	if (value === undefined) return null
	if (value === null) return null

	if (value instanceof Date) return value.toISOString()
	if (typeof value === "bigint") return value.toString()

	if (Array.isArray(value)) return value.map(normalizeForJson)

	if (typeof value === "object") {
		const record = value as Record<string, unknown>
		const out: Record<string, unknown> = {}
		for (const key of Object.keys(record).sort()) {
			const next = record[key]
			if (next === undefined) continue
			out[key] = normalizeForJson(next)
		}
		return out
	}

	return value
}

const canonicalJson = (value: unknown): string => JSON.stringify(normalizeForJson(value))

/**
 * Deterministic ID generator scoped to the currently executing/replaying action.
 *
 * - IDs are generated in TypeScript (not DB triggers) so they work across client DBs (e.g. SQLite).
 * - `withActionContext` must wrap any action execution that calls `forRow`, otherwise `forRow` fails.
 */
export class DeterministicId extends Effect.Service<DeterministicId>()("DeterministicId", {
	effect: Effect.gen(function* () {
		const stateRef = yield* FiberRef.make<State>({
			actionId: null,
			collisionByKey: new Map()
		})

		const withActionContext = <A, E, R>(actionId: string, effect: Effect.Effect<A, E, R>) =>
			effect.pipe(
				Effect.locally(stateRef, {
					actionId,
					collisionByKey: new Map()
				})
			)

		const getCurrentActionId = () => FiberRef.get(stateRef).pipe(Effect.map((s) => s.actionId))

		const forRow = (tableName: string, row: Record<string, unknown>) =>
			Effect.gen(function* () {
				const state = yield* FiberRef.get(stateRef)
				if (state.actionId === null) {
					return yield* Effect.fail(
						new DeterministicIdError({
							message: "DeterministicId.forRow called without an active action context"
						})
					)
				}

				const rowWithoutId: Record<string, unknown> = {}
				for (const [key, value] of Object.entries(row)) {
					if (key === "id") continue
					if (value === undefined) continue
					rowWithoutId[key] = value
				}

				const canonical = canonicalJson(rowWithoutId)
				const collisionKey = `${tableName}|${canonical}`
				const collisionIndex = state.collisionByKey.get(collisionKey) ?? 0

				const nextCollisionByKey = new Map(state.collisionByKey)
				nextCollisionByKey.set(collisionKey, collisionIndex + 1)
				yield* FiberRef.set(stateRef, { ...state, collisionByKey: nextCollisionByKey })

				const name = `${tableName}|${canonical}|${collisionIndex}`
				const actionId = state.actionId
				const namespace = validateUuid(actionId) ? actionId : NIL
				const nameForUuid = validateUuid(actionId) ? name : `${actionId}|${name}`

				return uuidv5(nameForUuid, namespace)
			})

		return {
			withActionContext,
			getCurrentActionId,
			forRow
		} as const
	})
}) {}
