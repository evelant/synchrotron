import type { SqlError } from "@effect/sql/SqlError"
import {
	SendLocalActionsBehindHead,
	SendLocalActionsDenied,
	SendLocalActionsInternal,
	SendLocalActionsInvalid,
	type SendLocalActionsFailure
} from "@synchrotron/sync-core/SyncNetworkService"

export const isSendLocalActionsFailure = (error: unknown): error is SendLocalActionsFailure =>
	error instanceof SendLocalActionsBehindHead ||
	error instanceof SendLocalActionsDenied ||
	error instanceof SendLocalActionsInvalid ||
	error instanceof SendLocalActionsInternal

export const hasTag = (value: unknown, tag: string): boolean =>
	typeof value === "object" && value !== null && (value as { readonly _tag?: unknown })._tag === tag

export const sqlErrorInfoFromCause = (
	cause: unknown
): { readonly code?: string; readonly message?: string } => {
	const seen = new Set<object>()
	let current: unknown = cause

	for (let depth = 0; depth < 10; depth++) {
		if (typeof current !== "object" || current === null) return {}
		if (seen.has(current)) return {}
		seen.add(current)

		const tagged = current as {
			readonly code?: unknown
			readonly sqlState?: unknown
			readonly message?: unknown
		}
		const code =
			typeof tagged.code === "string"
				? tagged.code
				: typeof tagged.sqlState === "string"
					? tagged.sqlState
					: undefined
		const message = typeof tagged.message === "string" ? tagged.message : undefined
		if (typeof code === "string" || typeof message === "string") {
			return {
				...(typeof code === "string" ? { code } : {}),
				...(typeof message === "string" ? { message } : {})
			}
		}

		const nested = current as {
			readonly cause?: unknown
			readonly error?: unknown
			readonly originalError?: unknown
		}
		current =
			typeof nested.cause !== "undefined"
				? nested.cause
				: typeof nested.error !== "undefined"
					? nested.error
					: nested.originalError
	}

	return {}
}

export const classifyUploadSqlError = (error: SqlError): SendLocalActionsFailure => {
	const cause = (error as { readonly cause?: unknown }).cause
	const info = sqlErrorInfoFromCause(cause)
	const code = info.code
	const outerMessage = error.message ?? "SQL error during SendLocalActions"
	const message =
		info.message && (outerMessage === "Failed to execute statement" || outerMessage.length === 0)
			? info.message
			: outerMessage
	const lowered = message.toLowerCase()

	// Postgres SQLSTATE:
	// - 42501: insufficient_privilege (includes RLS policy violations)
	// - 28***: invalid authorization specification / authentication failures
	if (
		code === "42501" ||
		(typeof code === "string" && code.startsWith("28")) ||
		lowered.includes("row-level security") ||
		lowered.includes("permission denied")
	) {
		return new SendLocalActionsDenied({ message, code })
	}

	// 22***: data exception, 23***: integrity constraint violation
	if (
		(typeof code === "string" && (code.startsWith("22") || code.startsWith("23"))) ||
		lowered.includes("violates")
	) {
		return new SendLocalActionsInvalid({ message, code })
	}

	return new SendLocalActionsInternal({ message })
}

export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && Array.isArray(value) === false
