declare module "react-native-mmkv" {
	export type MmkvConfig = {
		readonly id?: string | undefined
		readonly encryptionKey?: string | undefined
	}

	export interface MmkvInstance {
		getString(key: string): string | undefined
		set(key: string, value: string): void
		remove(key: string): void
		getAllKeys(): Array<string>
		clearAll(): void
	}

	export const createMMKV: (config?: MmkvConfig) => MmkvInstance
}
