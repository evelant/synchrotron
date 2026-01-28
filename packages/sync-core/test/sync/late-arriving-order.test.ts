import { PgliteClient } from "@effect/sql-pglite"
import { describe, expect, it } from "@effect/vitest"
import { CorrectionActionTag } from "@synchrotron/sync-core/SyncActionTags"
import type { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"
import { Effect, Option } from "effect"
import { createTestClient, makeTestLayers } from "../helpers/TestLayers"

const waitForNextMillisecond = Effect.sync(() => {
	const start = Date.now()
	while (Date.now() <= start) {
		// busy-wait: HLC uses Date.now(), not Effect TestClock
	}
})

const insertOnServer = (
	serverSql: PgliteClient.PgliteClient,
	action: ActionRecord,
	amrs: readonly ActionModifiedRow[]
) =>
	Effect.gen(function* () {
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
				${action.id},
				${action.client_id},
				${action._tag},
				${serverSql.json(action.args)},
				${serverSql.json(action.clock)},
				1,
				${action.transaction_id},
				${new Date(action.created_at).toISOString()}
			)
			ON CONFLICT (id) DO NOTHING
		`

		for (const amr of amrs) {
			yield* serverSql`INSERT INTO action_modified_rows ${serverSql.insert({
				...amr,
				forward_patches: serverSql.json(amr.forward_patches),
				reverse_patches: serverSql.json(amr.reverse_patches)
			})} ON CONFLICT (id) DO NOTHING`
		}
	})

describe("Late-arriving action ordering", () => {
	it.scoped(
		"late-arriving older actions should not overwrite newer applied state (requires rollback+replay)",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const remoteNew = yield* createTestClient("remoteNew", serverSql).pipe(Effect.orDie)
				const remoteOld = yield* createTestClient("remoteOld", serverSql).pipe(Effect.orDie)
				const receiver = yield* createTestClient("receiver", serverSql).pipe(Effect.orDie)

				const { result: createdNote, actionRecord: createAction } =
					yield* remoteNew.syncService.executeAction(
						remoteNew.testHelpers.createNoteAction({
							title: "Base",
							content: "",
							user_id: "user-1"
						})
					)
				const createAmrs = yield* remoteNew.actionModifiedRowRepo.findByActionRecordIds([
					createAction.id
				])
				expect(createAmrs.length).toBeGreaterThan(0)
				yield* insertOnServer(serverSql, createAction, createAmrs)

				yield* receiver.syncService.performSync()
				yield* remoteOld.syncService.performSync()

				const noteOnReceiver = yield* receiver.noteRepo.findById(createdNote.id)
				expect(noteOnReceiver._tag).toBe("Some")

				const { actionRecord: oldUpdate } = yield* remoteOld.syncService.executeAction(
					remoteOld.testHelpers.updateTitleAction({
						id: createdNote.id,
						title: "Title-old"
					})
				)

				yield* waitForNextMillisecond

				const { actionRecord: newUpdate } = yield* remoteNew.syncService.executeAction(
					remoteNew.testHelpers.updateTitleAction({
						id: createdNote.id,
						title: "Title-new"
					})
				)

				expect(oldUpdate.clock.timestamp).toBeLessThan(newUpdate.clock.timestamp)

				const newUpdateAmrs = yield* remoteNew.actionModifiedRowRepo.findByActionRecordIds([
					newUpdate.id
				])
				expect(newUpdateAmrs.length).toBeGreaterThan(0)
				yield* insertOnServer(serverSql, newUpdate, newUpdateAmrs)

				yield* receiver.syncService.performSync()

				const receiverAfterNew = yield* receiver.noteRepo.findById(createdNote.id)
				expect(receiverAfterNew.pipe(Option.map((n) => n.title)).pipe(Option.getOrThrow)).toBe(
					"Title-new"
				)

				const correctionActionsAfterNew =
					yield* receiver.actionRecordRepo.findByTag(CorrectionActionTag)
				expect(correctionActionsAfterNew.length).toBe(0)

				const oldUpdateAmrs = yield* remoteOld.actionModifiedRowRepo.findByActionRecordIds([
					oldUpdate.id
				])
				expect(oldUpdateAmrs.length).toBeGreaterThan(0)
				yield* insertOnServer(serverSql, oldUpdate, oldUpdateAmrs)

				yield* receiver.syncService.performSync()

				// Desired behavior: receiver should incorporate the late old action into history
				// (rollback+replay) so the newer action still wins.
				const receiverAfterLateOld = yield* receiver.noteRepo.findById(createdNote.id)
				expect(receiverAfterLateOld.pipe(Option.map((n) => n.title)).pipe(Option.getOrThrow)).toBe(
					"Title-new"
				)
			}).pipe(Effect.provide(makeTestLayers("server"))),
		30_000
	)

	it.scoped(
		"rollback marker + late-arriving older action triggers rollback+replay even with no local pending actions",
		() =>
			Effect.gen(function* () {
				const serverSql = yield* PgliteClient.PgliteClient

				const remoteNew = yield* createTestClient("remoteNew", serverSql).pipe(Effect.orDie)
				const remoteOld = yield* createTestClient("remoteOld", serverSql).pipe(Effect.orDie)
				const receiver = yield* createTestClient("receiver", serverSql).pipe(Effect.orDie)

				const { result: createdNote, actionRecord: createAction } =
					yield* remoteNew.syncService.executeAction(
						remoteNew.testHelpers.createNoteAction({
							title: "Base",
							content: "",
							user_id: "user-1",
							timestamp: 1000
						})
					)
				const createAmrs = yield* remoteNew.actionModifiedRowRepo.findByActionRecordIds([
					createAction.id
				])
				expect(createAmrs.length).toBeGreaterThan(0)
				yield* insertOnServer(serverSql, createAction, createAmrs)

				yield* remoteOld.syncService.performSync()

				const { actionRecord: oldUpdate } = yield* remoteOld.syncService.executeAction(
					remoteOld.testHelpers.updateTitleAction({
						id: createdNote.id,
						title: "Title-old",
						timestamp: 1100
					})
				)
				const oldUpdateAmrs = yield* remoteOld.actionModifiedRowRepo.findByActionRecordIds([
					oldUpdate.id
				])
				expect(oldUpdateAmrs.length).toBeGreaterThan(0)

				yield* waitForNextMillisecond

				const { actionRecord: newUpdate } = yield* remoteNew.syncService.executeAction(
					remoteNew.testHelpers.updateTitleAction({
						id: createdNote.id,
						title: "Title-new",
						timestamp: 1200
					})
				)
				const newUpdateAmrs = yield* remoteNew.actionModifiedRowRepo.findByActionRecordIds([
					newUpdate.id
				])
				expect(newUpdateAmrs.length).toBeGreaterThan(0)
				yield* insertOnServer(serverSql, newUpdate, newUpdateAmrs)

				// Force deterministic replay order on the server before the receiver's first sync:
				// create < oldUpdate < rollbackMarker < newUpdate
				const baseClockTime = Date.now()
				yield* serverSql`UPDATE action_records SET clock = ${serverSql.json({
					timestamp: baseClockTime,
					vector: {}
				})} WHERE id = ${createAction.id}`
				yield* serverSql`UPDATE action_records SET clock = ${serverSql.json({
					timestamp: baseClockTime + 3,
					vector: {}
				})} WHERE id = ${newUpdate.id}`

				yield* receiver.syncService.performSync()
				const receiverAfterNew = yield* receiver.noteRepo.findById(createdNote.id)
				expect(receiverAfterNew.pipe(Option.map((n) => n.title)).pipe(Option.getOrThrow)).toBe(
					"Title-new"
				)

				const rollbackActionId = crypto.randomUUID()
				const rollbackClockTime = baseClockTime + 2
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
						${"server"},
						${"RollbackAction"},
						${serverSql.json({ target_action_id: createAction.id, timestamp: rollbackClockTime })},
						${serverSql.json({ timestamp: rollbackClockTime, vector: {} })},
						1,
						${Date.now()},
						${new Date().toISOString()}
					)
				`

				// Late-arriving older action comes in after newUpdate by server_ingest_id,
				// but has an older clock so it belongs earlier in the canonical replay order.
				yield* insertOnServer(serverSql, oldUpdate, oldUpdateAmrs)
				yield* serverSql`UPDATE action_records SET clock = ${serverSql.json({
					timestamp: baseClockTime + 1,
					vector: {}
				})} WHERE id = ${oldUpdate.id}`

				yield* receiver.syncService.performSync()

				// Desired behavior: rollback marker triggers rollback+replay so the already-applied newUpdate
				// is re-applied after incorporating the late oldUpdate, leaving the final state as Title-new.
				const receiverAfterLateOldAndRollback = yield* receiver.noteRepo.findById(createdNote.id)
				expect(
					receiverAfterLateOldAndRollback.pipe(Option.map((n) => n.title)).pipe(Option.getOrThrow)
				).toBe("Title-new")
			}).pipe(Effect.provide(makeTestLayers("server"))),
		30_000
	)
})
