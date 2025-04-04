import { PgLiteClient } from "@effect/sql-pglite"
import { electricSync } from "@electric-sql/pglite-sync"
import { live } from "@electric-sql/pglite/live"

export const PgLiteSyncTag = PgLiteClient.tag<{
	live: typeof live
	electric: ReturnType<typeof electricSync>
}>()
export const PgLiteClientLive = PgLiteClient.layer({
	dataDir: "idb://synchrotron",
	relaxedDurability: true,
	extensions: {
		electric: electricSync(),
		live
	}
})
