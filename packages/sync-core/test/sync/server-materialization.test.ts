import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

const waitForNextMillisecond = Effect.sync(() => {
	const start = Date.now()
	while (Date.now() <= start) {
		// busy-wait: HLC uses Date.now(), not Effect TestClock
	}
})

describe("Server materialization", () => {
	it.scoped(
		"duplicate upload of the same batch is idempotent",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)

				const { result: note, actionRecord } = yield* clientA.syncService.executeAction(
					clientA.testHelpers.createNoteAction({
						title: "Idempotent",
						content: "",
						user_id: "user-1",
						timestamp: 1000
					})
				)

				const actionsToSend = yield* clientA.actionRecordRepo.allUnsynced()
				const amrsToSend = yield* clientA.actionModifiedRowRepo.allUnsynced()
				const basisServerIngestId = yield* clientA.clockService.getLastSeenServerIngestId

				yield* clientA.syncNetworkService.sendLocalActions(actionsToSend, amrsToSend, basisServerIngestId)

				const before = yield* serverSql<{ id: string; title: string }>`
					SELECT id, title FROM notes WHERE id = ${note.id}
				`
				expect(before[0]?.title).toBe("Idempotent")

				const amrCountBefore = yield* serverSql<{ count: number }>`
					SELECT count(*)::int as count FROM action_modified_rows WHERE action_record_id = ${actionRecord.id}
				`

				// Retry the exact same upload (e.g. lost ACK); server should not duplicate rows or re-apply.
				yield* clientA.syncNetworkService.sendLocalActions(actionsToSend, amrsToSend, basisServerIngestId)

				const after = yield* serverSql<{ id: string; title: string }>`
					SELECT id, title FROM notes WHERE id = ${note.id}
				`
				expect(after[0]?.title).toBe("Idempotent")

				const actionCount = yield* serverSql<{ count: number }>`
					SELECT count(*)::int as count FROM action_records WHERE id = ${actionRecord.id}
				`
				expect(actionCount[0]?.count).toBe(1)

				const amrCountAfter = yield* serverSql<{ count: number }>`
					SELECT count(*)::int as count FROM action_modified_rows WHERE action_record_id = ${actionRecord.id}
				`
				expect(amrCountAfter[0]?.count).toBe(amrCountBefore[0]?.count)
			}).pipe(Effect.provide(makeTestLayers("server"))),
			{ timeout: 30000 }
	)

	it.scoped(
		"materializes SYNC corrections (server reflects last canonical SYNC overwrite)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const source = yield* createTestClient("source", serverSql).pipe(Effect.orDie)
				const clientA = yield* createTestClient("clientA", serverSql).pipe(Effect.orDie)
				const clientB = yield* createTestClient("clientB", serverSql).pipe(Effect.orDie)

				const { result: note } = yield* source.syncService.executeAction(
					source.testHelpers.createNoteAction({
						title: "SYNC materialization",
						content: "Initial",
						user_id: "user-1",
						timestamp: 1000
					})
				)

				yield* source.syncService.performSync()
				yield* clientA.syncService.performSync()
				yield* clientB.syncService.performSync()

				yield* source.syncService.executeAction(
					source.testHelpers.clientSpecificContentAction({
						id: note.id,
						baseContent: "Base",
						timestamp: 2000
					})
				)
				yield* source.syncService.performSync()

				// Client A emits a SYNC overwrite (Base-clientA) and uploads it.
				yield* clientA.syncService.performSync()
				yield* clientA.syncService.performSync()

				yield* waitForNextMillisecond

				// Client B receives base + A's SYNC, emits its own SYNC overwrite (Base-clientB), and uploads it.
				yield* clientB.syncService.performSync()
				yield* clientB.syncService.performSync()

				// Server materialization should match the last SYNC overwrite in canonical order.
				const serverNote = yield* serverSql<{ readonly content: string }>`
					SELECT content
					FROM notes
					WHERE id = ${note.id}
				`
				expect(serverNote[0]?.content).toBe("Base-clientB")
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)

	it.scoped(
		"late-arriving older actions do not overwrite newer applied state (server rollback+replay)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const clientOld = yield* createTestClient("clientOld", serverSql).pipe(Effect.orDie)
				const clientNew = yield* createTestClient("clientNew", serverSql).pipe(Effect.orDie)

				const { result: note } = yield* clientNew.syncService.executeAction(
					clientNew.testHelpers.createNoteAction({
						title: "Base",
						content: "",
						user_id: "user-1",
						timestamp: 1000
					})
				)
				yield* clientNew.syncService.performSync()

				// Ensure clientOld has the base note so it can create an offline update.
				yield* clientOld.syncService.performSync()

				yield* clientOld.syncService.executeAction(
					clientOld.testHelpers.updateTitleAction({
						id: note.id,
						title: "Title-old",
						timestamp: 1100
					})
				)

				yield* waitForNextMillisecond

				yield* clientNew.syncService.executeAction(
					clientNew.testHelpers.updateTitleAction({
						id: note.id,
						title: "Title-new",
						timestamp: 1200
					})
				)
				yield* clientNew.syncService.performSync()

				const serverNoteBefore = yield* serverSql<{ id: string; title: string }>`
					SELECT id, title FROM notes WHERE id = ${note.id}
				`
				expect(serverNoteBefore[0]?.title).toBe("Title-new")

				// clientOld is at HEAD (after fetching), but uploads an older-HLC action that belongs before
				// the already-applied update. Server must rollback+replay patches so Title-new still wins.
				yield* clientOld.syncService.performSync()

				const serverNoteAfter = yield* serverSql<{ id: string; title: string }>`
					SELECT id, title FROM notes WHERE id = ${note.id}
				`
				expect(serverNoteAfter[0]?.title).toBe("Title-new")
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)

	it.scoped(
		"late-arriving multi-AMR action is replayed correctly on the server (sequence-sensitive patches)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const clientOld = yield* createTestClient("clientOld", serverSql).pipe(Effect.orDie)
				const clientNew = yield* createTestClient("clientNew", serverSql).pipe(Effect.orDie)

				const { result: note } = yield* clientNew.syncService.executeAction(
					clientNew.testHelpers.createNoteAction({
						title: "Base",
						content: "",
						user_id: "user-1",
						timestamp: 1000
					})
				)
				yield* clientNew.syncService.performSync()

				// Ensure clientOld has the base note so it can create an offline multi-step update.
				yield* clientOld.syncService.performSync()

				const clientOldSql = clientOld.rawSql
				const multiUpdateTitleAction = clientOld.actionRegistry.defineAction(
					"test-multi-update-title",
					Schema.Struct({
						id: Schema.String,
						firstTitle: Schema.String,
						secondTitle: Schema.String,
						timestamp: Schema.Number
					}),
					(args) =>
						Effect.gen(function* () {
							yield* clientOldSql`
								UPDATE notes
								SET title = ${args.firstTitle}, updated_at = ${new Date(
									args.timestamp
								).toISOString()}
								WHERE id = ${args.id}
							`
							yield* clientOldSql`
								UPDATE notes
								SET title = ${args.secondTitle}, updated_at = ${new Date(
									args.timestamp + 1
								).toISOString()}
								WHERE id = ${args.id}
							`
						})
				)

				const { actionRecord: multiAction } = yield* clientOld.syncService.executeAction(
					multiUpdateTitleAction({
						id: note.id,
						firstTitle: "Title-old-1",
						secondTitle: "Title-old-2",
						timestamp: 1100
					})
				)

				yield* waitForNextMillisecond

				yield* clientNew.syncService.executeAction(
					clientNew.testHelpers.updateTitleAction({
						id: note.id,
						title: "Title-new",
						timestamp: 1200
					})
				)
				yield* clientNew.syncService.performSync()

				const serverNoteBefore = yield* serverSql<{ title: string }>`
					SELECT title FROM notes WHERE id = ${note.id}
				`
				expect(serverNoteBefore[0]?.title).toBe("Title-new")

				// Upload late-arriving multi-step update (older in replay order). Server must rewind + replay
				// and still converge to the correct final state.
				yield* clientOld.syncService.performSync()

				const serverNoteAfter = yield* serverSql<{ title: string }>`
					SELECT title FROM notes WHERE id = ${note.id}
				`
				expect(serverNoteAfter[0]?.title).toBe("Title-new")

				const amrs = yield* serverSql<{ sequence: number }>`
					SELECT sequence
					FROM action_modified_rows
					WHERE action_record_id = ${multiAction.id}
					ORDER BY sequence ASC, id ASC
				`
				expect(amrs.map((r) => r.sequence)).toEqual([0, 1])
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)

	it.scoped(
		"materializes multiple late-arriving actions from different clients (rewind + replay)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const creator = yield* createTestClient("creator", serverSql).pipe(Effect.orDie)
				const clientOldA = yield* createTestClient("clientOldA", serverSql).pipe(Effect.orDie)
				const clientOldB = yield* createTestClient("clientOldB", serverSql).pipe(Effect.orDie)
				const clientNew1 = yield* createTestClient("clientNew1", serverSql).pipe(Effect.orDie)
				const clientNew2 = yield* createTestClient("clientNew2", serverSql).pipe(Effect.orDie)

				const { result: note } = yield* creator.syncService.executeAction(
					creator.testHelpers.createNoteAction({
						title: "Base",
						content: "",
						user_id: "user-1",
						timestamp: 1000
					})
				)
				yield* creator.syncService.performSync()

				// Everyone fetches the base note.
				yield* clientOldA.syncService.performSync()
				yield* clientOldB.syncService.performSync()
				yield* clientNew1.syncService.performSync()
				yield* clientNew2.syncService.performSync()

				// clientOldA creates an offline update that is older than both remote updates.
				yield* clientOldA.syncService.executeAction(
					clientOldA.testHelpers.updateTitleAction({
						id: note.id,
						title: "Title-old-0",
						timestamp: 1100
					})
				)
				yield* waitForNextMillisecond

				yield* clientNew1.syncService.executeAction(
					clientNew1.testHelpers.updateTitleAction({
						id: note.id,
						title: "Title-new-1",
						timestamp: 1200
					})
				)
				yield* clientNew1.syncService.performSync()
				yield* waitForNextMillisecond

				// clientOldB creates an offline update that belongs between new-1 and new-2 in replay order.
				yield* clientOldB.syncService.executeAction(
					clientOldB.testHelpers.updateTitleAction({
						id: note.id,
						title: "Title-old-1",
						timestamp: 1300
					})
				)
				yield* waitForNextMillisecond

				yield* clientNew2.syncService.executeAction(
					clientNew2.testHelpers.updateTitleAction({
						id: note.id,
						title: "Title-new-2",
						timestamp: 1400
					})
				)
				yield* clientNew2.syncService.performSync()

				const serverAfterNew2 = yield* serverSql<{ title: string }>`
					SELECT title FROM notes WHERE id = ${note.id}
				`
				expect(serverAfterNew2[0]?.title).toBe("Title-new-2")

				// Upload late-arriving older actions; server must rewind+replay so Title-new-2 remains final.
				yield* clientOldA.syncService.performSync()
				const serverAfterOldA = yield* serverSql<{ title: string }>`
					SELECT title FROM notes WHERE id = ${note.id}
				`
				expect(serverAfterOldA[0]?.title).toBe("Title-new-2")

				yield* clientOldB.syncService.performSync()
				const serverAfterOldB = yield* serverSql<{ title: string }>`
					SELECT title FROM notes WHERE id = ${note.id}
				`
				expect(serverAfterOldB[0]?.title).toBe("Title-new-2")
			}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)

	it.scoped(
		"late-arriving insert does not resurrect a row after a newer delete (delete ordering)",
		() =>
				Effect.gen(function* () {
					const serverSql = yield* PgliteClient.PgliteClient

					const creator = yield* createTestClient("creator", serverSql).pipe(Effect.orDie)
					const deleter = yield* createTestClient("deleter", serverSql).pipe(Effect.orDie)
					const reCreator = yield* createTestClient("reCreator", serverSql).pipe(Effect.orDie)

				const noteId = crypto.randomUUID()
				yield* creator.syncService.executeAction(
					creator.testHelpers.createNoteWithIdAction({
						id: noteId,
						title: "Base",
						content: "",
						user_id: "user-1",
						timestamp: 1000
					})
				)
				yield* creator.syncService.performSync()

					// Ensure deleter sees the note so its delete produces patches.
					yield* deleter.syncService.performSync()

					// Create the same note offline (same id), but keep it pending.
					const { result: recreated, actionRecord: recreateAction } =
						yield* reCreator.syncService.executeAction(
							reCreator.testHelpers.createNoteWithIdAction({
								id: noteId,
								title: "Base",
								content: "",
								user_id: "user-1",
								timestamp: 1000
							})
						)
					expect(recreated.id).toBe(noteId)

				yield* waitForNextMillisecond

					const { actionRecord: deleteAction } = yield* deleter.syncService.executeAction(
						deleter.testHelpers.deleteContentAction({
							id: noteId,
							user_id: "user-1",
							timestamp: 2000
						})
					)
					expect(recreateAction.clock.timestamp).toBeLessThan(deleteAction.clock.timestamp)
					yield* deleter.syncService.performSync()

				const afterDelete = yield* serverSql<{ count: number }>`
					SELECT count(*)::int as count FROM notes WHERE id = ${noteId}
				`
				expect(afterDelete[0]?.count).toBe(0)

				// Upload the older insert after the delete; server must rewind+replay so the delete still wins.
				//
				// We bypass client-side fetch/apply here (the point of this test is server materialization under
				// late arrival). HEAD-gating is satisfied by setting the basis cursor to the current head.
				const headRow = yield* serverSql<{ head: number | string | null }>`
					SELECT max(server_ingest_id) as head FROM action_records
				`
				const head = Number(headRow[0]?.head ?? 0)
				yield* reCreator.clockService.advanceLastSeenServerIngestId(head)

				const actionsToSend = yield* reCreator.actionRecordRepo.allUnsynced()
				const amrsToSend = yield* reCreator.actionModifiedRowRepo.allUnsynced()
				const basisServerIngestId = yield* reCreator.clockService.getLastSeenServerIngestId
				yield* reCreator.syncNetworkService.sendLocalActions(actionsToSend, amrsToSend, basisServerIngestId)

					const afterLateInsert = yield* serverSql<{ count: number }>`
						SELECT count(*)::int as count FROM notes WHERE id = ${noteId}
					`
					expect(afterLateInsert[0]?.count).toBe(0)
				}).pipe(Effect.provide(makeTestLayers("server"))),
		{ timeout: 30000 }
	)
})
