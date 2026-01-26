import { KeyValueStore } from "@effect/platform"
import { ClientIdentity } from "@synchrotron/sync-core/ClientIdentity"
import { ClientIdOverride } from "@synchrotron/sync-core/ClientIdOverride"
import { ClientId } from "@synchrotron/sync-core/models"
import { Effect, Layer, Option } from "effect"

export const ClientIdentityTestLive = Layer.effect(
	ClientIdentity,
	Effect.gen(function* () {
		const keyValueStore = yield* KeyValueStore.KeyValueStore
		const overrideOption = yield* Effect.serviceOption(ClientIdOverride)

		const resolve = Effect.gen(function* () {
			if (Option.isSome(overrideOption)) {
				return ClientId.make(overrideOption.value)
			}

			const existingIdOption = yield* keyValueStore.get("sync_client_id")
			if (Option.isSome(existingIdOption)) {
				return ClientId.make(existingIdOption.value)
			}

			const newClientId = crypto.randomUUID()
			yield* keyValueStore.set("sync_client_id", newClientId)
			return ClientId.make(newClientId)
		})

		const clientId = yield* resolve
		return { get: Effect.succeed(clientId) } as const
	})
)
