import * as Sql from "@effect/sql"
import { PgLiteClient } from "@effect/sql-pglite"
import { live } from "@electric-sql/pglite/live"
import { electricSync } from "@electric-sql/pglite-sync"
import { Effect, Layer } from "effect"


export const PgLiteSyncTag = PgLiteClient.tag<{ live: typeof live, electric: ReturnType<typeof electricSync> }>()
export const PgLiteClientLive = PgLiteClient.layer({
  dataDir: "idb://synchrotron",
  relaxedDurability: true,
  extensions: {
    electric: electricSync(),
    live
  }, 
}).pipe(
  Layer.tapErrorCause(Effect.logError)
)

export const SqlClient = Sql.SqlClient