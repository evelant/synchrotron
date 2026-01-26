import { Effect, Schema } from "effect"
import type { Action } from "./models"

/**
 * Error for unknown action types
 */
export class UnknownActionError extends Schema.TaggedError<UnknownActionError>()(
	"UnknownActionError",
	{
		actionTag: Schema.String
	}
) {}

export type ActionCreator = (
	args: Record<string, unknown>
) => Action<unknown, Record<string, unknown>, unknown, never>

/**
 * ActionRegistry Service
 * Manages a registry of action creators that can be used to create and execute actions
 */
export class ActionRegistry extends Effect.Service<ActionRegistry>()("ActionRegistry", {
	effect: Effect.sync(() => {
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
		const defineAction = <A1, A extends Record<string, unknown> & { timestamp: number }, EE>(
			tag: string,
			argsSchema: Schema.Schema<A>,
			actionFn: (args: A) => Effect.Effect<A1, EE, never>
		) => {
			type ArgsWithoutTimestamp = Omit<A, "timestamp">

			const decodeArgs = (args: Record<string, unknown>): A => {
				const timestamp = typeof args.timestamp === "number" ? args.timestamp : Date.now()
				return Schema.decodeUnknownSync(argsSchema)({ ...args, timestamp })
			}

			const createActionFromRecord = (args: Record<string, unknown>): Action<A1, A, EE, never> => {
				const decodedArgs = decodeArgs(args)
				Object.freeze(decodedArgs)

				const action: Action<A1, A, EE, never> = {
					_tag: tag,
					execute: () => actionFn(decodedArgs),
					args: decodedArgs
				}
				Object.freeze(action)
				return action
			}

			const createAction = (
				args: ArgsWithoutTimestamp & { timestamp?: number | undefined }
			): Action<A1, A, EE, never> => createActionFromRecord(args)

			registerActionCreator(tag, createActionFromRecord)

			return createAction
		}

		const rollbackAction = defineAction(
			"RollbackAction",
			Schema.Struct({ target_action_id: Schema.NullOr(Schema.String), timestamp: Schema.Number }),
			// Args: only target_action_id and timestamp are needed for the record
			(args: { target_action_id: string | null; timestamp: number }) =>
				Effect.gen(function* () {
					// This action's execute method now only records the event.
					// The actual database state rollback happens in SyncService.rollbackToCommonAncestor
					// *before* this action is executed.
					yield* Effect.logInfo(
						`Executing no-op RollbackAction targeting ancestor: ${args.target_action_id ?? "<genesis>"}`
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
