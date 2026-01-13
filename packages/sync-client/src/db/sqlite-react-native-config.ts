export interface SqliteReactNativeClientConfig {
	readonly filename: string
	readonly location?: string | undefined
	readonly encryptionKey?: string | undefined
	readonly spanAttributes?: Record<string, unknown> | undefined
	readonly transformResultNames?: ((str: string) => string) | undefined
	readonly transformQueryNames?: ((str: string) => string) | undefined
}

