import { KeyValueStore } from "@effect/platform"
import * as PlatformError from "@effect/platform/Error"
import { Effect, Layer, Option } from "effect"
import { createMMKV } from "react-native-mmkv"

export type MmkvKeyValueStoreConfig = Readonly<{
	/**
	 * MMKV instance id. Use a dedicated instance to avoid key collisions.
	 */
	id: string
}>

const mmkvError = (method: string, key: string | undefined, cause: unknown) =>
	new PlatformError.SystemError({
		reason: "Unknown",
		module: "KeyValueStore",
		method,
		pathOrDescriptor: key,
		description: "react-native-mmkv error",
		cause
	})

export const makeMmkvKeyValueStoreLayer = (config: MmkvKeyValueStoreConfig) =>
	Layer.sync(KeyValueStore.KeyValueStore, () => {
		const mmkv = createMMKV({ id: config.id })

		return KeyValueStore.makeStringOnly({
			get: (key) =>
				Effect.try({
					try: () => Option.fromNullable(mmkv.getString(key)),
					catch: (cause) => mmkvError("get", key, cause)
				}),
			set: (key, value) =>
				Effect.try({
					try: () => mmkv.set(key, value),
					catch: (cause) => mmkvError("set", key, cause)
				}),
			remove: (key) =>
				Effect.try({
					try: () => mmkv.remove(key),
					catch: (cause) => mmkvError("remove", key, cause)
				}),
			clear: Effect.try({
				try: () => mmkv.clearAll(),
				catch: (cause) => mmkvError("clear", undefined, cause)
			}),
			size: Effect.try({
				try: () => mmkv.getAllKeys().length,
				catch: (cause) => mmkvError("size", undefined, cause)
			})
		})
	})

/**
 * Default KeyValueStore for React Native native runtimes.
 *
 * Requires `react-native-mmkv` to be installed in the app.
 */
export const SynchrotronKeyValueStoreLive = makeMmkvKeyValueStoreLayer({ id: "synchrotron" })
