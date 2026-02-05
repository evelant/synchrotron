import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { CorrectionActionTag } from "@synchrotron/sync-core/SyncActionTags"
import type { ActionRecord } from "@synchrotron/sync-core/models"
import { Effect, Option } from "effect"
import { makeSqliteTestServerLayer, withSqliteTestClients } from "../helpers/SqliteTestLayers"

describe("Sync Algorithm Integration (SQLite clients)", () => {
	it.scoped(
		"should apply remote actions when no local actions are pending (no divergence)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient
				yield* withSqliteTestClients(["client1", "remoteClient"], serverSql, undefined, (clients) =>
					Effect.gen(function* () {
						const client1 = clients[0]!
						const remoteClient = clients[1]!

						const createNoteAction = remoteClient.testHelpers.createNoteAction

						const { actionRecord: remoteActionRecord, result: remoteNoteResult } =
							yield* remoteClient.syncService.executeAction(
								createNoteAction({
									title: "Remote Note",
									content: "Content from remote",
									user_id: "remote-user"
								})
							)
						const remoteNoteId = remoteNoteResult.id

						yield* remoteClient.syncService.performSync()

						const initialPendingClient1 = yield* client1.actionRecordRepo.findBySynced(false)
						expect(initialPendingClient1.length).toBe(0)

						const result = yield* client1.syncService.performSync()

						expect(result.length).toBe(1)
						expect(result[0]?.id).toBe(remoteActionRecord.id)
						expect(result[0]?._tag).toBe("test-create-note")

						const localNote = yield* client1.noteRepo.findById(remoteNoteId)
						expect(localNote._tag).toBe("Some")
						if (localNote._tag === "Some") {
							expect(localNote.value.title).toBe("Remote Note")
							expect(localNote.value.user_id).toBe("remote-user")
						}

						const isAppliedClient1 = yield* client1.actionRecordRepo.isLocallyApplied(
							remoteActionRecord.id
						)
						expect(isAppliedClient1).toBe(true)

						const correctionRecordsClient1 =
							yield* client1.actionRecordRepo.findByTag(CorrectionActionTag)
						expect(correctionRecordsClient1.length).toBe(0)

						const serverAction =
							yield* serverSql<ActionRecord>`SELECT * FROM action_records WHERE id = ${remoteActionRecord.id}`
						expect(serverAction.length).toBe(1)
						expect(serverAction[0]?.synced).toBe(1)
					})
				)
			}).pipe(Effect.provide(makeSqliteTestServerLayer())),
		{ timeout: 30000 }
	)

	it.scoped(
		"should correctly handle concurrent modifications to different fields",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient
				yield* withSqliteTestClients(["client1", "client2"], serverSql, undefined, (clients) =>
					Effect.gen(function* () {
						const client1 = clients[0]!
						const client2 = clients[1]!

						const createNoteAction = client1.testHelpers.createNoteAction
						const updateTitleActionC1 = client1.testHelpers.updateTitleAction
						const updateContentActionC2 = client2.testHelpers.updateContentAction

						const { result: initialNoteResult } = yield* client1.syncService.executeAction(
							createNoteAction({
								title: "Initial Title",
								content: "Initial content",
								user_id: "test-user",
								tags: ["initial"]
							})
						)
						const initialNoteId = initialNoteResult.id

						yield* client1.syncService.performSync()
						yield* client2.syncService.performSync()

						const { actionRecord: updateTitleRecord } = yield* client1.syncService.executeAction(
							updateTitleActionC1({
								id: initialNoteId,
								title: "Updated Title from Client 1"
							})
						)

						const { actionRecord: updateContentRecord } = yield* client2.syncService.executeAction(
							updateContentActionC2({
								id: initialNoteId,
								content: "Updated content from Client 2"
							})
						)

						const client1Note = yield* client1.noteRepo.findById(initialNoteId)
						const client2Note = yield* client2.noteRepo.findById(initialNoteId)
						expect(client1Note._tag).toBe("Some")
						expect(client2Note._tag).toBe("Some")
						if (client1Note._tag === "Some" && client2Note._tag === "Some") {
							expect(client1Note.value.title).toBe("Updated Title from Client 1")
							expect(client1Note.value.content).toBe("Initial content")
							expect(client2Note.value.title).toBe("Initial Title")
							expect(client2Note.value.content).toBe("Updated content from Client 2")
						}

						yield* client1.syncService.performSync()
						yield* client2.syncService.performSync()
						yield* client1.syncService.performSync()

						const finalClient1Note = yield* client1.noteRepo.findById(initialNoteId)
						const finalClient2Note = yield* client2.noteRepo.findById(initialNoteId)
						expect(finalClient1Note._tag).toBe("Some")
						expect(finalClient2Note._tag).toBe("Some")
						if (finalClient1Note._tag === "Some" && finalClient2Note._tag === "Some") {
							expect(finalClient1Note.value.title).toBe("Updated Title from Client 1")
							expect(finalClient1Note.value.content).toBe("Updated content from Client 2")
							expect(finalClient1Note.value).toEqual(finalClient2Note.value)
						}

						const rollbackClient2 = yield* client2.actionRecordRepo.findByTag("RollbackAction")
						expect(rollbackClient2.length).toBeGreaterThan(0)

						const titleAppliedC1 = yield* client1.actionRecordRepo.isLocallyApplied(
							updateTitleRecord.id
						)
						const contentAppliedC1 = yield* client1.actionRecordRepo.isLocallyApplied(
							updateContentRecord.id
						)
						const titleAppliedC2 = yield* client2.actionRecordRepo.isLocallyApplied(
							updateTitleRecord.id
						)
						const contentAppliedC2 = yield* client2.actionRecordRepo.isLocallyApplied(
							updateContentRecord.id
						)

						expect(titleAppliedC1).toBe(true)
						expect(contentAppliedC1).toBe(true)
						expect(titleAppliedC2).toBe(true)
						expect(contentAppliedC2).toBe(true)

						const originalTitleSynced = yield* client1.actionRecordRepo.findById(
							updateTitleRecord.id
						)
						const originalContentSynced = yield* client2.actionRecordRepo.findById(
							updateContentRecord.id
						)
						expect(
							originalTitleSynced.pipe(Option.map((a) => a.synced)).pipe(Option.getOrThrow)
						).toBe(true)
						expect(
							originalContentSynced.pipe(Option.map((a) => a.synced)).pipe(Option.getOrThrow)
						).toBe(true)
					})
				)
			}).pipe(Effect.provide(makeSqliteTestServerLayer())),
		{ timeout: 30000 }
	)
})
