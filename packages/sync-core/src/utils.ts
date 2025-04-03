/**
 * Simple recursive deep object comparison. Handles plain objects and primitive values.
 * Does not handle complex types like Dates, Maps, Sets, etc., but should suffice for JSON patches.
 */
export const deepObjectEquals = (objA: unknown, objB: unknown): boolean => {
	// Removed ignoreKeys
	// Strict equality check handles primitives and same references
	if (objA === objB) return true

	// Check if both are non-null objects
	const isObjectA = typeof objA === "object" && objA !== null
	const isObjectB = typeof objB === "object" && objB !== null

	// If they are not both non-null objects, they aren't deeply equal (unless === was true)
	if (!isObjectA || !isObjectB) return false

	// Cast to Record<string, unknown> after confirming they are objects
	// Use type assertion as we've checked they are objects
	const recordA = objA as Record<string, unknown>
	const recordB = objB as Record<string, unknown>

	// Use original keys
	const keysA = Object.keys(recordA)
	const keysB = Object.keys(recordB)

	// Check if they have the same number of keys
	if (keysA.length !== keysB.length) return false

	// Check if keys and values match
	for (const key of keysA) {
		// Iterate over all keys
		// Check if key exists in B
		if (!Object.prototype.hasOwnProperty.call(recordB, key)) {
			return false
		}
		const valA = recordA[key]
		const valB = recordB[key]

		// Explicitly check for undefined due to noUncheckedIndexAccess
		if (valA === undefined || valB === undefined) {
			// If one is undefined and the other isn't, they are not equal.
			// If both are undefined, the initial === check would have caught it.
			if (valA !== valB) return false
			// If both are undefined, continue (handled by initial === check)
			continue
		}

		// Now we know both valA and valB are defined, proceed with comparison
		// Recursively call without ignoreKeys
		if (!deepObjectEquals(valA, valB)) {
			return false
		}
	}

	return true
}
