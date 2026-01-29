import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { HLC } from "@synchrotron/sync-core/HLC"
import { bindJsonParam } from "@synchrotron/sync-core/SqlJson"
import { RemoteActionFetchError } from "@synchrotron/sync-core/SyncNetworkService"
import { Effect } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("Sync doctor recovery", () => {
	const serverNotesSnapshot = (serverSql: PgliteClient.PgliteClient) =>
		Effect.gen(function* () {
			const epochRows = yield* serverSql<{ readonly server_epoch: string }>`
				SELECT server_epoch::text AS server_epoch
				FROM sync_server_meta
				WHERE id = 1
			`
			const serverEpoch = epochRows[0]?.server_epoch ?? "test-epoch"

			const minRows = yield* serverSql<{
				readonly min_server_ingest_id: number | string | bigint | null
			}>`
				SELECT COALESCE(MIN(server_ingest_id), 0) as min_server_ingest_id
				FROM action_records
			`
			const minRetainedServerIngestId = Number(minRows[0]?.min_server_ingest_id ?? 0)

			const headRows = yield* serverSql<{ readonly max_server_ingest_id: number | string }>`
				SELECT COALESCE(MAX(server_ingest_id), 0) as max_server_ingest_id
				FROM action_records
			`
			const serverIngestId = Number(headRows[0]?.max_server_ingest_id ?? 0)

			const notes = yield* serverSql<Record<string, unknown>>`
				SELECT * FROM notes ORDER BY id ASC
			`

			return {
				serverEpoch,
				minRetainedServerIngestId,
				serverIngestId,
				serverClock: HLC.make(),
				tables: [{ tableName: "notes", rows: notes }]
			} as const
		}).pipe(
			Effect.mapError(
				(error) =>
					new RemoteActionFetchError({
						message: error instanceof Error ? error.message : String(error),
						cause: error
					})
			)
		)

	it.scoped(
		"detects cursor/applied-set corruption and auto-hardResyncs",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const clientB = yield* createTestClient("clientB", serverSql).pipe(Effect.orDie)
				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)

				yield* clientB.syncService.executeAction(
					clientB.testHelpers.createNoteAction({
						title: "Server note",
						content: "from server",
						user_id: "user-1",
						timestamp: 1000
					})
				)
				yield* clientB.syncService.performSync()

				yield* clientA.syncNetworkServiceTestHelpers.setBootstrapSnapshot(
					serverNotesSnapshot(serverSql)
				)

				const { result: strayNote, actionRecord: strayActionRecord } =
					yield* clientA.syncService.executeAction(
						clientA.testHelpers.createNoteAction({
							title: "Local stray note",
							content: "should be discarded",
							user_id: "user-1",
							timestamp: 900
						})
					)
				yield* clientA.rawSql`DELETE FROM action_modified_rows WHERE action_record_id = ${strayActionRecord.id}`
				yield* clientA.rawSql`DELETE FROM local_applied_action_ids WHERE action_record_id = ${strayActionRecord.id}`
				yield* clientA.rawSql`DELETE FROM action_records WHERE id = ${strayActionRecord.id}`

				const clientId = yield* clientA.clockState.getClientId
				yield* clientA.clockState.getLastSeenServerIngestId

				const badActionId = "sync-doctor-bad-action"
				yield* clientA.rawSql`
					INSERT INTO action_records (
						server_ingest_id,
						id,
						_tag,
						user_id,
						client_id,
						transaction_id,
						clock,
						args,
						synced
					) VALUES (
						5,
						${badActionId},
						${"test-unknown-action"},
						NULL,
						${"clientB"},
						${Date.now()},
						${bindJsonParam(clientA.rawSql, HLC.make())},
						${bindJsonParam(clientA.rawSql, {})},
						1
					)
				`

				yield* clientA.rawSql`
					UPDATE client_sync_status
					SET last_seen_server_ingest_id = 10
					WHERE client_id = ${clientId}
				`

				const exit = yield* clientA.syncService.performSync().pipe(Effect.exit)
				expect(exit._tag).toBe("Success")

				const stray = yield* clientA.noteRepo.findByTitle("Local stray note")
				expect(stray.length).toBe(0)

				const serverNotes = yield* clientA.noteRepo.findByTitle("Server note")
				expect(serverNotes.length).toBe(1)
				expect(serverNotes[0]?.id).toBeDefined()
				expect(serverNotes[0]?.id).not.toBe(strayNote.id)

				const badRows = yield* clientA.rawSql<{ readonly count: number | string }>`
					SELECT COUNT(*)::int AS count FROM action_records WHERE id = ${badActionId}
				`
				expect(Number(badRows[0]?.count ?? 0)).toBe(0)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
