import { SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import { ActionModifiedRowRepo } from "./ActionModifiedRowRepo"
import { ActionRecordRepo } from "./ActionRecordRepo"
import { Action } from "./models"

/**
 * Error for unknown action types
 */
export class UnknownActionError extends Schema.TaggedError<UnknownActionError>()(
	"UnknownActionError",
	{
		actionTag: Schema.String
	}
) {}

export type ActionCreator = <A extends Record<string, unknown> = any, EE = any, R = never>(
	args: A
) => Action<A, EE, R>

/**
 * ActionRegistry Service
 * Manages a registry of action creators that can be used to create and execute actions
 */
export class ActionRegistry extends Effect.Service<ActionRegistry>()("ActionRegistry", {
	effect: Effect.gen(function* () {
		// Create a new registry map
		const registry = new Map<string, ActionCreator>()

		/**
		 * Get an action creator from the registry by tag
		 * Used during replay of actions from ActionRecords
		 */
		const getActionCreator = (tag: string): ActionCreator | undefined => {
			return registry.get(tag)
		}

		/**
		 * Register an action creator in the registry
		 */
		const registerActionCreator = (tag: string, creator: ActionCreator): void => {
			registry.set(tag, creator)
		}

		/**
		 * Check if an action creator exists in the registry
		 */
		const hasActionCreator = (tag: string): boolean => {
			return registry.has(tag)
		}

		/**
		 * Remove an action creator from the registry
		 */
		const removeActionCreator = (tag: string): boolean => {
			return registry.delete(tag)
		}

		/**
		 * Get the size of the registry
		 */
		const getRegistrySize = (): number => {
			return registry.size
		}

		/**
		 * Helper to create a type-safe action definition that automatically registers with the registry
		 */
		// A represents the arguments provided by the caller (without timestamp)
		const defineAction = <A extends Record<string, unknown> & { timestamp: number }, EE, R = never>(
			tag: string,
			actionFn: (args: A) => Effect.Effect<void, EE, R> // The implementation receives timestamp
		) => {
			// Create action constructor function
			// createAction now accepts the full arguments object 'A', including the timestamp
			const createAction = (
				args: Omit<A, "timestamp"> & { timestamp?: number | undefined }
			): Action<A, EE, R> => {
				if (typeof args.timestamp !== "number") {
					// If timestamp is not provided, use the current timestamp
					args.timestamp = Date.now()
				}
				return {
					_tag: tag,
					// The execute function now takes no parameters.
					// It uses the 'args' captured in this closure when createAction was called.
					execute: () => actionFn(args as any),
					// Store the full args object (including timestamp) that was used to create this action instance.
					args: args as any
				}
			}

			// Automatically register the action creator in the registry
			registerActionCreator(tag, createAction as ActionCreator)

			// Return the action creator function
			return createAction
		}

		const rollbackAction = defineAction(
			"RollbackAction",
			// Args: only target_action_id and timestamp are needed for the record
			(args: { target_action_id: string; timestamp: number }) =>
				Effect.gen(function* () {
					// This action's execute method now only records the event.
					// The actual database state rollback happens in SyncService.rollbackToCommonAncestor
					// *before* this action is executed.
					yield* Effect.logInfo(
						`Executing no-op RollbackAction targeting ancestor: ${args.target_action_id}`
					)
					// No database operations or trigger disabling needed here.
				})
		)
		return {
			getActionCreator,
			registerActionCreator,
			hasActionCreator,
			removeActionCreator,
			getRegistrySize,
			defineAction,
			rollbackAction
		}
	})
}) {}
