import { SqlClient } from "@effect/sql"
import { describe, expect, it } from "@effect/vitest"
import { initializeDatabaseSchema } from "@synchrotron/sync-core/db"
import { Duration, Effect, Layer } from "effect"
import { SyncServerService } from "../src/SyncServerService"
import { makeServerSqlLayer } from "./e2e/harness"

describe("server retention/compaction", () => {
	it.scoped(
		"deletes action log rows older than retention (by server_ingested_at)",
		() =>
			Effect.gen(function* () {
				const dataDir = `memory://server-${crypto.randomUUID()}`
				const layer = SyncServerService.Default.pipe(
					Layer.provideMerge(makeServerSqlLayer(dataDir))
				)
				const context = yield* Layer.build(layer)

				yield* initializeDatabaseSchema.pipe(Effect.provide(context))

				const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(context))
				const server = yield* SyncServerService.pipe(Effect.provide(context))

				const insertAction = (serverIngestId: number, clientId: string, counter: number) => {
					const clock = { timestamp: Date.now(), vector: { [clientId]: counter } }
					const args = { timestamp: clock.timestamp, test: serverIngestId }
					const argsJson = JSON.stringify(args)
					const clockJson = JSON.stringify(clock)
					return sql`
						INSERT INTO action_records (
							server_ingest_id,
							id,
							user_id,
							client_id,
							_tag,
							args,
							clock,
							synced,
							transaction_id,
							created_at
						) VALUES (
							${serverIngestId},
							${crypto.randomUUID()},
							NULL,
							${clientId},
							${`test-${serverIngestId}`},
							${argsJson}::jsonb,
							${clockJson}::jsonb,
							1,
							${serverIngestId},
							NOW()
						)
					`.pipe(Effect.asVoid)
				}

				const insertAmr = (actionRecordId: string, sequence: number) => {
					const forwardJson = JSON.stringify({ foo: "bar" })
					const reverseJson = JSON.stringify({})
					return sql`
						INSERT INTO action_modified_rows (
							id,
							table_name,
							row_id,
							action_record_id,
							audience_key,
							operation,
							forward_patches,
							reverse_patches,
							sequence
						) VALUES (
							${crypto.randomUUID()},
							'notes',
							${crypto.randomUUID()},
							${actionRecordId},
							'audience:test',
							'INSERT',
							${forwardJson}::jsonb,
							${reverseJson}::jsonb,
							${sequence}
						)
					`.pipe(Effect.asVoid)
				}

				yield* insertAction(1, "clientA", 1)
				yield* insertAction(2, "clientA", 2)
				yield* insertAction(3, "clientA", 3)

				const actionIds = yield* sql<{
					readonly id: string
					readonly server_ingest_id: number | string
				}>`
					SELECT id, server_ingest_id
					FROM action_records
					WHERE server_ingest_id IS NOT NULL
					ORDER BY server_ingest_id ASC
				`
				expect(actionIds.length).toBe(3)

				for (const [idx, row] of actionIds.entries()) {
					yield* insertAmr(row.id, idx)
				}

				yield* sql`
					UPDATE action_records
					SET server_ingested_at = NOW() - INTERVAL '30 days'
					WHERE server_ingest_id <= 2
				`.pipe(Effect.asVoid)

				const result = yield* server.compactActionLogOnce(Duration.days(14))
				expect(result.deletedActionCount).toBe(2)

				const remaining = yield* sql<{ readonly server_ingest_id: number | string }>`
					SELECT server_ingest_id
					FROM action_records
					WHERE server_ingest_id IS NOT NULL
					ORDER BY server_ingest_id ASC
				`
				expect(remaining.map((r) => Number(r.server_ingest_id))).toEqual([3])

				const amrCountRows = yield* sql<{ readonly count: number | string }>`
					SELECT count(*) AS count FROM action_modified_rows
				`
				const amrCount = Number(amrCountRows[0]?.count ?? 0)
				expect(amrCount).toBe(1)

				const minRows = yield* sql<{ readonly min_id: number | string | null }>`
					SELECT COALESCE(MIN(server_ingest_id), 0) AS min_id
					FROM action_records
				`
				expect(Number(minRows[0]?.min_id ?? 0)).toBe(3)
			}),
		{ timeout: 30_000 }
	)
})
