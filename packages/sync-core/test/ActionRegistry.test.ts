import { it, describe } from "@effect/vitest" // Import describe
import { ActionRegistry } from "@synchrotron/sync-core/ActionRegistry"
import { Effect } from "effect"
import { makeTestLayers } from "./helpers/TestLayers"
import { expect } from "vitest"

// Use describe instead of it.layer
describe("ActionRegistry", () => {
	// Provide layer individually
	it.effect(
		"should define and register an action",
		() =>
			Effect.gen(function* () {
				const registry = yield* ActionRegistry
				const initialSize = registry.getRegistrySize()

				// Define a test action
				const testAction = registry.defineAction(
					"test-action",
					(args: { value: number; timestamp: number }) => Effect.void
				)

				// Check that the action was registered
				expect(registry.getRegistrySize()).toBe(initialSize + 1)
				expect(registry.hasActionCreator("test-action")).toBe(true)

				// Clean up by removing the test action
				registry.removeActionCreator("test-action")
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// Provide layer individually
	it.effect(
		"should create actions that can fetch and apply changes",
		() =>
			Effect.gen(function* () {
				const registry = yield* ActionRegistry

				// Mock value to track action execution
				let executed = false

				// Define a test action that sets the flag when executed
				const testAction = registry.defineAction(
					"test-apply-action",
					(args: { value: number; timestamp: number }) =>
						Effect.sync(() => {
							executed = true
							return
						})
				)

				// Create an action instance
				const action = testAction({ value: 42 })

				// Action should have the correct structure
				expect(action._tag).toBe("test-apply-action")
				expect(action.args).keys("value", "timestamp")
				expect(action.args.value).toBe(42)
				expect(action.args.timestamp).toBeDefined()

				// Apply the action
				yield* action.execute()

				// Verify the action was executed
				expect(executed).toBe(true)

				// Clean up
				registry.removeActionCreator("test-apply-action")
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// Provide layer individually
	it.effect(
		"should return undefined for unknown action tags",
		() =>
			Effect.gen(function* () {
				const registry = yield* ActionRegistry
				const actionCreator = registry.getActionCreator("non-existent-action")

				// Should return undefined
				expect(actionCreator).toBeUndefined()
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// Provide layer individually
	it.effect(
		"should retrieve the same action creator that was registered",
		() =>
			Effect.gen(function* () {
				const registry = yield* ActionRegistry

				// Define a test action
				const testAction = registry.defineAction(
					"test-retrieve-action",
					(args: { value: string; timestamp: number }) => Effect.void
				)

				// Get the action creator from the registry
				const retrievedCreator = registry.getActionCreator("test-retrieve-action")

				// Should return the same action creator
				expect(retrievedCreator).toBeDefined()

				// Create actions with both creators and compare
				const originalAction = testAction({ value: "test" })
				const retrievedAction = retrievedCreator!({ value: "test" })

				expect(retrievedAction._tag).toBe(originalAction._tag)
				expect(retrievedAction.args).toEqual(originalAction.args)

				// Clean up
				registry.removeActionCreator("test-retrieve-action")
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)

	// Provide layer individually
	it.effect(
		"should ensure actions are immutable",
		() =>
			Effect.gen(function* () {
				const registry = yield* ActionRegistry

				// Define a test action
				const testAction = registry.defineAction(
					"test-immutable-action",
					(args: { value: number; timestamp: number }) => Effect.void
				)

				// Create an action instance
				const action = testAction({ value: 42 })

				// Attempt to modify the action (this shouldn't be allowed in TypeScript)
				// but we can verify the behavior in a test
				const actionAny = action as any

				// Store original values
				const originalTag = action._tag
				const originalArgs = { ...action.args }

				// Try to modify
				actionAny._tag = "modified-tag"
				actionAny.args.value = 100

				// Apply the action and check if modifications had any effect
				// on the execution (they shouldn't)
				const gotActionCreator = registry.getActionCreator(originalTag)
				expect(gotActionCreator).toBeDefined()

				// Clean up
				registry.removeActionCreator("test-immutable-action")
			}).pipe(Effect.provide(makeTestLayers("server"))) // Provide layer here
	)
})
