import { Function, Order, Schema, Struct, pipe } from "effect"

/**
 * Rounding factor for timestamps in the clock to reduce sensitivity to clock drift.
 * A larger rounding factor will reduce sensitivity to clock drift causing events within
 * the same window to be ordered by the logical portion of clock
 */
// const DRIFT_WINDOW = 5000
// export const roundTimestamp = (timestamp: number) => Math.floor(timestamp / DRIFT_WINDOW)
const currentTimestamp = () => Date.now() //roundTimestamp(Date.now())

/**
 * A Hybrid Logical Clock (HLC) is a clock that combines a logical clock (LC) and a physical clock (PC)
 * to provide a consistent ordering of events in distributed systems.
 *
 * The HLC is a tuple of (timestamp, clock).
 *
 * The timestamp is the physical clock time in milliseconds.
 *
 * The clock is a record mapping client IDs to their logical counters, allowing for a total ordering of actions
 * even if the physical clocks are skewed between clients.
 */
export const HLC = Schema.Struct({
	vector: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.Number }), {
		default: () => ({})
	}),
	timestamp: Schema.optionalWith(Schema.Number, { default: currentTimestamp })
})
export type HLC = typeof HLC.Type

export const make = (
	options?: Partial<{ timestamp: number; vector: Record<string, number> }>
): HLC => {
	return HLC.make({
		timestamp: options?.timestamp ?? 0,
		vector: options?.vector ?? {}
	})
}

export const valueForNode = Function.dual<
	(id: string) => (self: HLC) => number,
	(self: HLC, id: string) => number
>(2, (self, id) => self.vector[id] ?? 0)

export const increment = Function.dual<
	(id: string) => (self: HLC) => HLC,
	(self: HLC, id: string) => HLC
>(2, (clock, id) =>
	pipe(
		clock,
		Struct.evolve({
			vector: (c) => ({
				...c,
				[id]: valueForNode(clock, id) + 1
			}),
			timestamp: (t) => Math.max(t, currentTimestamp())
		})
	)
)

const orderLogical = (first: HLC, second: HLC): -1 | 0 | 1 => {
	// Check keys in first clock
	const firstClockRecord = first.vector
	for (const [key, value] of Object.entries(firstClockRecord)) {
		const otherValue = valueForNode(second, key)
		if (value > otherValue) return 1
		if (value < otherValue) return -1
	}

	// Check keys in second clock that aren't in first clock
	const secondClockRecord = second.vector
	for (const [key, value] of Object.entries(secondClockRecord)) {
		if (key in firstClockRecord) continue // Already checked above
		if (value > 0) return -1 // Any positive value in second but not in first means second is ahead
	}

	// If we got here, all values are equal
	return 0
}

export const _order = Function.dual<
	(otherClock: HLC) => (self: HLC) => -1 | 0 | 1,
	(self: HLC, otherClock: HLC) => -1 | 0 | 1
>(2, (self, otherClock) =>
	self.timestamp > otherClock.timestamp
		? 1
		: self.timestamp < otherClock.timestamp
			? -1
			: orderLogical(self, otherClock)
)

export const order = Order.make(_order)

/**
 * Order HLCs with an explicit client ID tiebreaker
 */
export const orderWithClientId = Function.dual<
	(otherClock: HLC, otherClientId: string, selfClientId: string) => (self: HLC) => -1 | 0 | 1,
	(self: HLC, otherClock: HLC, selfClientId: string, otherClientId: string) => -1 | 0 | 1
>(4, (self, otherClock, selfClientId, otherClientId) => {
	const order = _order(self, otherClock)
	if (order !== 0) return order
	// Finally use client IDs as tiebreaker
	return selfClientId < otherClientId ? -1 : selfClientId > otherClientId ? 1 : 0
})

/**
 * Create an Order instance with client ID tiebreaking
 */
export const makeOrderWithClientId = (selfClientId: string, otherClientId: string) =>
	Order.make<HLC>((self, other) => orderWithClientId(self, other, selfClientId, otherClientId))

/**
 * Create a new local mutation by incrementing the clock for the specified client ID.
 * The counter always increments and never resets, even when physical time advances.
 */
export const createLocalMutation = Function.dual<
	(clientId: string) => (self: HLC) => HLC,
	(self: HLC, clientId: string) => HLC
>(2, (self, clientId) => {
	const now = currentTimestamp()
	return pipe(
		self,
		Struct.evolve({
			vector: (c) => ({
				...c,
				[clientId]: valueForNode(self, clientId) + 1
			}),
			timestamp: () => Math.max(now, self.timestamp)
		})
	)
})

/**
 * Receive a remote mutation and merge it with the local clock.
 * This handles merging logical counters and advancing physical time appropriately.
 * Counters never reset, they are set to the maximum seen value.
 */
export const receiveRemoteMutation = Function.dual<
	(incomingClock: HLC, clientId: string) => (self: HLC) => HLC,
	(self: HLC, incomingClock: HLC, clientId: string) => HLC
>(3, (self, incomingClock, clientId) => {
	const now = currentTimestamp()
	const newTimestamp = Math.max(self.timestamp, incomingClock.timestamp, now)

	// Merge vectors by taking the maximum value for each key
	const mergedVector = { ...self.vector }

	// Find the highest counter across all received vectors
	let maxCounter = 0
	for (const value of Object.values(incomingClock.vector)) {
		maxCounter = Math.max(maxCounter, value)
	}

	// Set client's own vector counter to max if greater than current
	const currentClientValue = valueForNode(self, clientId)
	if (maxCounter > currentClientValue) {
		mergedVector[clientId] = maxCounter
	}

	// Also merge the rest of the vector entries
	for (const [key, value] of Object.entries(incomingClock.vector)) {
		if (key !== clientId) {
			mergedVector[key] = Math.max(value, valueForNode(self, key))
		}
	}

	return HLC.make({
		vector: mergedVector,
		timestamp: newTimestamp
	})
})

/**
 * Check if one HLC is causally before another
 */
export const isBefore = Function.dual<
	(otherClock: HLC) => (self: HLC) => boolean,
	(self: HLC, otherClock: HLC) => boolean
>(2, (self, otherClock) => _order(self, otherClock) === -1)

/**
 * Check if one HLC is causally after another
 */
export const isAfter = Function.dual<
	(otherClock: HLC) => (self: HLC) => boolean,
	(self: HLC, otherClock: HLC) => boolean
>(2, (self, otherClock) => _order(self, otherClock) === 1)

/**
 * Check if two HLCs are concurrent (neither is causally before or after the other)
 * With vector clocks, we can detect concurrency more explicitly.
 */
export const isConcurrent = Function.dual<
	(otherClock: HLC) => (self: HLC) => boolean,
	(self: HLC, otherClock: HLC) => boolean
>(2, (self, otherClock) => {
	// If physical timestamps are different, they're not concurrent
	if (self.timestamp !== otherClock.timestamp) {
		return false
	}

	// Check if either clock has vector entries the other doesn't know about
	const selfVector = self.vector
	const otherVector = otherClock.vector

	// Check if there's at least one client where self is ahead and one where other is ahead
	let selfAheadSomewhere = false
	let otherAheadSomewhere = false

	// Check all keys in self
	for (const [clientId, selfCounter] of Object.entries(selfVector)) {
		const otherCounter = otherVector[clientId] ?? 0

		if (selfCounter > otherCounter) {
			selfAheadSomewhere = true
		} else if (otherCounter > selfCounter) {
			otherAheadSomewhere = true
		}

		// If we've found both are ahead in different places, they're concurrent
		if (selfAheadSomewhere && otherAheadSomewhere) {
			return true
		}
	}

	// Check keys in other that aren't in self
	for (const [clientId, otherCounter] of Object.entries(otherVector)) {
		if (!(clientId in selfVector) && otherCounter > 0) {
			otherAheadSomewhere = true
		}

		// If we've found both are ahead in different places, they're concurrent
		if (selfAheadSomewhere && otherAheadSomewhere) {
			return true
		}
	}

	// If one is ahead somewhere but the other isn't ahead anywhere, they're not concurrent
	return false
})

/**
 * Get all client IDs that have entries in the clock
 */
export const getClientIds = (self: HLC): string[] => Object.keys(self.vector)

/**
 * Check if two HLCs are equal
 */
export const equals = Function.dual<
	(otherClock: HLC) => (self: HLC) => boolean,
	(self: HLC, otherClock: HLC) => boolean
>(2, (self, otherClock) => _order(self, otherClock) === 0)
