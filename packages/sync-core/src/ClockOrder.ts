import * as HLC from "./HLC"

export type ClockKey = {
	readonly clock: HLC.HLC
	readonly clientId: string
	readonly id?: string | number | undefined
}

/**
 * Canonical total order used throughout Synchrotron:
 * (clock_time_ms, clock_counter, client_id, id)
 *
 * Where `clock_counter` is derived from `clock.vector[client_id]`.
 */
export const compareClock = (a: ClockKey, b: ClockKey): number => {
	if (a.clock.timestamp !== b.clock.timestamp) {
		return a.clock.timestamp < b.clock.timestamp ? -1 : 1
	}

	const counterA = HLC.valueForNode(a.clock, a.clientId)
	const counterB = HLC.valueForNode(b.clock, b.clientId)
	if (counterA !== counterB) {
		return counterA < counterB ? -1 : 1
	}

	if (a.clientId !== b.clientId) {
		return a.clientId < b.clientId ? -1 : 1
	}

	const idA = a.id === undefined ? "" : String(a.id)
	const idB = b.id === undefined ? "" : String(b.id)
	if (idA !== idB) {
		return idA < idB ? -1 : 1
	}

	return 0
}

export const sortClocks = <T extends ClockKey>(items: ReadonlyArray<T>): Array<T> =>
	[...items].sort(compareClock)

/**
 * Find the latest common ancestor clock between a client's synced local actions and a set of remote actions.
 *
 * Used to pick a rollback point for conflict resolution:
 * - consider only `synced === true` local actions (server-acknowledged)
 * - pick the newest such action that is causally before every remote action
 */
export const findLatestCommonClock = <
	LocalAction extends {
		readonly clock: HLC.HLC
		readonly synced: boolean | undefined
		readonly client_id: string
		readonly id?: string | number | undefined
	},
	RemoteAction extends { readonly clock: HLC.HLC }
>(
	localActions: ReadonlyArray<LocalAction>,
	remoteActions: ReadonlyArray<RemoteAction>
): HLC.HLC | null => {
	const syncedLocal = localActions.filter((a) => a.synced === true)
	if (syncedLocal.length === 0) return null

	const sortedSynced = sortClocks(
		syncedLocal.map((a) => ({
			clock: a.clock,
			clientId: a.client_id,
			id: a.id
		}))
	).reverse()

	const remoteClocks = remoteActions.map((a) => a.clock)

	for (const action of sortedSynced) {
		if (remoteClocks.every((remoteClock) => HLC.isBefore(action.clock, remoteClock))) {
			return action.clock
		}
	}

	return null
}
