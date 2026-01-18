import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import type { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"
import { Effect, Option } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

describe("Remote ingest semantics", () => {
	it.scoped(
		"applies remotely ingested actions even when fetch returns empty (DB-driven remote apply)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const remoteClient = yield* createTestClient("remoteClient", serverSql).pipe(Effect.orDie)
				const receiver = yield* createTestClient("receiver", serverSql).pipe(Effect.orDie)

				const { result: note, actionRecord } = yield* remoteClient.syncService.executeAction(
					remoteClient.testHelpers.createNoteAction({
						title: "Remote note",
						content: "",
						user_id: "user-1",
						timestamp: 1000
					})
				)
				yield* remoteClient.syncService.performSync()

				// Simulate Electric/custom transport ingress: insert remote rows into the receiver's
				// local action log tables without using the fetch path.
				const [serverAction] = yield* serverSql<ActionRecord>`
					SELECT * FROM action_records WHERE id = ${actionRecord.id}
				`
				expect(serverAction).toBeTruthy()
				if (!serverAction) return

				const serverAmrs = yield* serverSql<ActionModifiedRow>`
					SELECT *
					FROM action_modified_rows
					WHERE action_record_id = ${actionRecord.id}
					ORDER BY sequence ASC, id ASC
				`

				const receiverSql = receiver.rawSql
				const clientJson = (value: unknown) =>
					typeof (receiverSql as any).json === "function"
						? (receiverSql as any).json(value)
						: typeof value === "string"
							? value
							: JSON.stringify(value)

				yield* receiverSql`
					INSERT INTO action_records (
						server_ingest_id,
						id,
						client_id,
						_tag,
						args,
						clock,
						synced,
						transaction_id,
						created_at
					) VALUES (
						${serverAction.server_ingest_id},
						${serverAction.id},
						${serverAction.client_id},
						${serverAction._tag},
						${clientJson(serverAction.args)},
						${clientJson(serverAction.clock)},
						1,
						${serverAction.transaction_id},
						${new Date(serverAction.created_at).toISOString()}
					)
					ON CONFLICT (id) DO NOTHING
				`

				for (const row of serverAmrs) {
					yield* receiverSql`
						INSERT INTO action_modified_rows (
							id,
							table_name,
							row_id,
							action_record_id,
							operation,
							forward_patches,
							reverse_patches,
							sequence
						) VALUES (
							${row.id},
							${row.table_name},
							${row.row_id},
							${row.action_record_id},
							${row.operation},
							${clientJson(row.forward_patches)},
							${clientJson(row.reverse_patches)},
							${row.sequence}
						)
						ON CONFLICT (id) DO NOTHING
					`
				}

				// Force the network fetch path to return empty so the only way to apply the remote action
				// is by discovering it in the local DB.
				yield* receiver.syncNetworkServiceTestHelpers.setFetchResult(
					Effect.succeed({ actions: [], modifiedRows: [] })
				)

				const applied = yield* receiver.syncService.performSync()
				expect(applied.some((a) => a.id === actionRecord.id)).toBe(true)

				const noteOnReceiver = yield* receiver.noteRepo.findById(note.id)
				expect(noteOnReceiver._tag).toBe("Some")

				const lastSeen = yield* receiver.clockService.getLastSeenServerIngestId
				expect(lastSeen).toBe(Number(serverAction.server_ingest_id))
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)

	it.scoped(
		"RollbackAction is honored even when the client has no pending actions",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const remoteClient = yield* createTestClient("remoteClient", serverSql).pipe(Effect.orDie)
				const receiver = yield* createTestClient("receiver", serverSql).pipe(Effect.orDie)

				const { result: note1, actionRecord: action1 } =
					yield* remoteClient.syncService.executeAction(
						remoteClient.testHelpers.createNoteAction({
							title: "Before rollback",
							content: "",
							user_id: "user-1",
							timestamp: 1000
						})
					)
				yield* remoteClient.syncService.performSync()

				const rollbackActionId = crypto.randomUUID()
				const rollbackTransactionId = Date.now()
				yield* serverSql`
					INSERT INTO action_records (
						server_ingest_id,
						id,
						client_id,
						_tag,
						args,
						clock,
						synced,
						transaction_id,
						created_at
					) VALUES (
						nextval('action_records_server_ingest_id_seq'),
						${rollbackActionId},
						${"remoteClient"},
						${"RollbackAction"},
						${serverSql.json({ target_action_id: null, timestamp: 0 })},
						${serverSql.json({ timestamp: 0, vector: {} })},
						1,
						${rollbackTransactionId},
						${new Date().toISOString()}
					)
				`

				const { result: note2, actionRecord: action2 } =
					yield* remoteClient.syncService.executeAction(
						remoteClient.testHelpers.createNoteAction({
							title: "After rollback",
							content: "",
							user_id: "user-1",
							timestamp: 2000
						})
					)
				yield* remoteClient.syncService.performSync()

				// Ensure the rollback marker sorts between the two creates in replay order.
				const baseClockTime = Date.now()
				yield* serverSql`UPDATE action_records SET clock = ${serverSql.json({
					...action1.clock,
					timestamp: baseClockTime
				})} WHERE id = ${action1.id}`
				yield* serverSql`UPDATE action_records SET clock = ${serverSql.json({
					timestamp: baseClockTime + 1,
					vector: {}
				})}, args = ${serverSql.json({
					target_action_id: null,
					timestamp: baseClockTime + 1
				})} WHERE id = ${rollbackActionId}`
				yield* serverSql`UPDATE action_records SET clock = ${serverSql.json({
					...action2.clock,
					timestamp: baseClockTime + 2
				})} WHERE id = ${action2.id}`

				const applied = yield* receiver.syncService.performSync()
				expect(applied.map((a) => a._tag)).toEqual([
					"test-create-note",
					"RollbackAction",
					"test-create-note"
				])

				const rollbackLocallyApplied = yield* receiver.actionRecordRepo.isLocallyApplied(rollbackActionId)
				expect(rollbackLocallyApplied).toBe(true)

				// Desired behavior (per DESIGN.md): RollbackAction is a patch-less marker used to trigger
				// rollback+replay. It does not delete history; replay applies the canonical action set.
				const receiverNote1 = yield* receiver.noteRepo.findById(note1.id)
				expect(receiverNote1._tag).toBe("Some")

				const receiverNote2 = yield* receiver.noteRepo.findById(note2.id)
				expect(receiverNote2._tag).toBe("Some")

				const outgoingSyncDeltas = yield* receiver.actionRecordRepo.findByTag("_InternalSyncApply")
				expect(outgoingSyncDeltas.length).toBe(0)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)

	it.scoped(
		"HLC receive/merge: a local action created after observing a remote one sorts after it",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const remoteClient = yield* createTestClient("remoteClient", serverSql).pipe(Effect.orDie)
				const receiver = yield* createTestClient("receiver", serverSql).pipe(Effect.orDie)

				const { actionRecord: remoteAction } = yield* remoteClient.syncService.executeAction(
					remoteClient.testHelpers.createNoteAction({
						title: "Remote note",
						content: "",
						user_id: "user-1",
						timestamp: 1000
					})
				)
				yield* remoteClient.syncService.performSync()

				// Make the remote action's clock appear far in the future relative to the receiver.
				const remoteFutureTimeMs = Date.now() + 24 * 60 * 60 * 1000
				yield* serverSql`UPDATE action_records SET clock = ${serverSql.json({
					...remoteAction.clock,
					timestamp: remoteFutureTimeMs
				})} WHERE id = ${remoteAction.id}`

				yield* receiver.syncService.performSync()

				const observedRemote = yield* receiver.actionRecordRepo.findById(remoteAction.id)
				expect(observedRemote._tag).toBe("Some")
				if (observedRemote._tag !== "Some") return

				const { actionRecord: localAction } = yield* receiver.syncService.executeAction(
					receiver.testHelpers.createNoteAction({
						title: "Local-after-remote",
						content: "",
						user_id: "user-1",
						timestamp: 2000
					})
				)

				const ordering = receiver.clockService.compareClock(
					{ clock: localAction.clock, clientId: localAction.client_id, id: localAction.id },
					{
						clock: observedRemote.value.clock,
						clientId: observedRemote.value.client_id,
						id: observedRemote.value.id
					}
				)

				expect(ordering).toBeGreaterThan(0)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
