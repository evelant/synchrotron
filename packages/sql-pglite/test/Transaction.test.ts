import { PgLiteClient } from "@effect/sql-pglite"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"

const ClientLive = PgLiteClient.layer({ dataDir: "memory://" })

describe("PgLite Transaction", () => {
  it.layer(ClientLive, { timeout: "30 seconds" })(
    "should acquire and release a transaction",
    (it) => {
      it.effect("transaction test", () =>
        Effect.gen(function*() {
          const sql = yield* PgLiteClient.PgLiteClient

          // Setup a test table
          yield* sql`
          CREATE TABLE IF NOT EXISTS test_transactions (
            id INTEGER PRIMARY KEY,
            value TEXT
          )`

          yield* Effect.gen(function*() {
            yield* sql`INSERT INTO test_transactions (id, value) VALUES (1, 'transaction_test')`
            yield* sql`ROLLBACK`
          }).pipe(sql.withTransaction)

          // Verify the data was inserted
          const rows = yield* sql`SELECT * FROM test_transactions WHERE id = 1`
          expect(rows.length).toBe(0)
        }))
    }
  )
})
