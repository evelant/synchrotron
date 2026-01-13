import "react-native-get-random-values"

import { v4 as uuidv4 } from "uuid"

if (typeof globalThis.crypto === "undefined") {
	;(globalThis as unknown as { crypto: Record<string, unknown> }).crypto = {}
}
if (typeof globalThis.crypto.randomUUID !== "function") {
	;(globalThis.crypto as unknown as { randomUUID: () => string }).randomUUID = uuidv4
}

import { registerRootComponent } from "expo"

import App from "./App"

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App)
