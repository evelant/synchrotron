import { BrowserKeyValueStore } from "@effect/platform-browser"

/**
 * Default KeyValueStore for React Native web runtimes.
 */
export const SynchrotronKeyValueStoreLive = BrowserKeyValueStore.layerLocalStorage
