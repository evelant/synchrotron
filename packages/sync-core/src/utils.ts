/**
 * Simple recursive deep object comparison. Handles plain objects and primitive values.
 * Does not handle complex types like Dates, Maps, Sets, etc., but should suffice for JSON patches.
 */
export const deepObjectEquals = (objA: unknown, objB: unknown): boolean => {
	// Removed ignoreKeys
	// Strict equality check handles primitives and same references
	if (objA === objB) return true
	const isObjectA = typeof objA === "object" && objA !== null
	const isObjectB = typeof objB === "object" && objB !== null
	if (!isObjectA || !isObjectB) return false

	// Cast to Record<string, unknown> after confirming they are objects
	const recordA = objA as Record<string, unknown>
	const recordB = objB as Record<string, unknown>
	const keysA = Object.keys(recordA)
	const keysB = Object.keys(recordB)
	if (keysA.length !== keysB.length) return false
	for (const key of keysA) {
		// Iterate over all keys
		if (!Object.prototype.hasOwnProperty.call(recordB, key)) {
			return false
		}
		const valA = recordA[key]
		const valB = recordB[key]

		// Explicitly check for undefined due to noUncheckedIndexAccess
		if (valA === undefined || valB === undefined) {
			if (valA !== valB) return false
			continue
		}
		// Recursively call without ignoreKeys
		if (!deepObjectEquals(valA, valB)) {
			return false
		}
	}

	return true
}
