import { SqlClient, type SqlError } from "@effect/sql"
import { Effect, Layer } from "effect"
import createSyncTablesSqliteSQL from "./db/sql/schema/create_sync_tables_sqlite"
import { ClientDbAdapter } from "./ClientDbAdapter"

const ensureSqliteDialect = (sql: SqlClient.SqlClient) =>
	sql.onDialectOrElse({
		sqlite: () => Effect.void,
		orElse: () =>
			Effect.fail(
				new Error(
					`SqliteClientDbAdapter requires a SQLite SqlClient (got non-sqlite dialect)`
				)
			)
	})

export const SqliteClientDbAdapter = Layer.effect(
	ClientDbAdapter,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		yield* ensureSqliteDialect(sql)

		const initializeSyncSchema: Effect.Effect<void, SqlError.SqlError | Error> = Effect.gen(function* () {
			// better-sqlite3 (used by @effect/sql-sqlite-node) cannot prepare multi-statement SQL.
			// Execute the schema file one statement at a time.
			for (const statement of createSyncTablesSqliteSQL
				.split(";")
				.map((s) => s.trim())
				.filter((s) => s.length > 0)) {
				yield* sql.unsafe(statement).raw
			}

			// Per-connection TEMP table used by triggers for action association + sequencing.
			yield* sql`
				CREATE TEMP TABLE IF NOT EXISTS sync_context (
					capture_action_record_id TEXT,
					sequence INTEGER NOT NULL DEFAULT 0,
					disable_tracking INTEGER NOT NULL DEFAULT 0
				)
			`.raw

			// Ensure a single row exists.
			yield* sql`DELETE FROM sync_context`.raw
			yield* sql`
				INSERT INTO sync_context (capture_action_record_id, sequence, disable_tracking)
				VALUES (NULL, 0, 0)
			`.raw

			yield* Effect.logInfo("SQLite client database schema initialization complete")
		})

		const quoteSqliteIdentifier = (identifier: string) =>
			`"${identifier.replaceAll("\"", "\"\"").replaceAll(".", "\".\"")}"`

		const sqliteTriggerName = (tableName: string, op: string) => {
			const base = tableName.replaceAll(/[^a-zA-Z0-9_]/g, "_")
			return `sync_patches_${base}_${op}`.slice(0, 60)
		}

		const createSqlitePatchTriggersForTable = (tableName: string) =>
			Effect.gen(function* () {
				const columns = yield* sql<{ name: string }>`
					SELECT name FROM pragma_table_info(${tableName})
				`
				if (columns.length === 0) {
					return yield* Effect.fail(
						new Error(`Cannot install patch triggers: table not found: ${tableName}`)
					)
				}

				const columnNames = columns.map((c) => c.name)
				const hasId = columnNames.some((c) => c.toLowerCase() === "id")
				if (!hasId) {
					return yield* Effect.fail(
						new Error(`Cannot install patch triggers: table "${tableName}" must have an "id" column`)
					)
				}

				const nonIdColumns = columnNames.filter((c) => c.toLowerCase() !== "id")

				const tableIdent = quoteSqliteIdentifier(tableName)

				const jsonObjectFor = (prefix: "NEW" | "OLD") => {
					const parts: string[] = []
					for (const col of columnNames) {
						parts.push(`'${col.replaceAll("'", "''")}', ${prefix}.${quoteSqliteIdentifier(col)}`)
					}
					return `json_object(${parts.join(", ")})`
				}

				const changedCondition =
					nonIdColumns.length === 0
						? "0"
						: nonIdColumns
								.map(
									(col) =>
										`OLD.${quoteSqliteIdentifier(col)} IS NOT NEW.${quoteSqliteIdentifier(col)}`
								)
								.join(" OR ")

				const jsonPatchChain = (prefix: "NEW" | "OLD") => {
					let expr = `'{}'`
					for (const col of nonIdColumns) {
						const colLiteral = col.replaceAll("'", "''")
						const colIdent = quoteSqliteIdentifier(col)
						expr = `json_patch(${expr}, CASE WHEN OLD.${colIdent} IS NOT NEW.${colIdent} THEN json_object('${colLiteral}', ${prefix}.${colIdent}) ELSE '{}' END)`
					}
					return expr
				}

				const triggerInsertName = sqliteTriggerName(tableName, "insert")
				const triggerUpdateName = sqliteTriggerName(tableName, "update")
				const triggerDeleteName = sqliteTriggerName(tableName, "delete")

				// TEMP triggers so they can reliably reference TEMP sync_context.
				const insertTriggerSql = `
CREATE TEMP TRIGGER ${quoteSqliteIdentifier(triggerInsertName)}
AFTER INSERT ON ${tableIdent}
WHEN (SELECT disable_tracking FROM sync_context LIMIT 1) = 0
BEGIN
  SELECT
    CASE
      WHEN (SELECT capture_action_record_id FROM sync_context LIMIT 1) IS NULL
        OR (SELECT capture_action_record_id FROM sync_context LIMIT 1) = ''
      THEN RAISE(ABORT, 'sync.capture_action_record_id not set')
    END;

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
    (SELECT capture_action_record_id FROM sync_context LIMIT 1) || ':' || (SELECT sequence FROM sync_context LIMIT 1),
    '${tableName.replaceAll("'", "''")}',
    NEW.${quoteSqliteIdentifier("id")},
    (SELECT capture_action_record_id FROM sync_context LIMIT 1),
    'INSERT',
    ${jsonObjectFor("NEW")},
    '{}',
    (SELECT sequence FROM sync_context LIMIT 1)
  );

  UPDATE sync_context SET sequence = sequence + 1;
END;
`

				const deleteTriggerSql = `
CREATE TEMP TRIGGER ${quoteSqliteIdentifier(triggerDeleteName)}
AFTER DELETE ON ${tableIdent}
WHEN (SELECT disable_tracking FROM sync_context LIMIT 1) = 0
BEGIN
  SELECT
    CASE
      WHEN (SELECT capture_action_record_id FROM sync_context LIMIT 1) IS NULL
        OR (SELECT capture_action_record_id FROM sync_context LIMIT 1) = ''
      THEN RAISE(ABORT, 'sync.capture_action_record_id not set')
    END;

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
    (SELECT capture_action_record_id FROM sync_context LIMIT 1) || ':' || (SELECT sequence FROM sync_context LIMIT 1),
    '${tableName.replaceAll("'", "''")}',
    OLD.${quoteSqliteIdentifier("id")},
    (SELECT capture_action_record_id FROM sync_context LIMIT 1),
    'DELETE',
    '{}',
    ${jsonObjectFor("OLD")},
    (SELECT sequence FROM sync_context LIMIT 1)
  );

  UPDATE sync_context SET sequence = sequence + 1;
END;
`

				const updateTriggerSql = `
CREATE TEMP TRIGGER ${quoteSqliteIdentifier(triggerUpdateName)}
AFTER UPDATE ON ${tableIdent}
WHEN (SELECT disable_tracking FROM sync_context LIMIT 1) = 0
  AND (${changedCondition})
BEGIN
  SELECT
    CASE
      WHEN (SELECT capture_action_record_id FROM sync_context LIMIT 1) IS NULL
        OR (SELECT capture_action_record_id FROM sync_context LIMIT 1) = ''
      THEN RAISE(ABORT, 'sync.capture_action_record_id not set')
    END;

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
    (SELECT capture_action_record_id FROM sync_context LIMIT 1) || ':' || (SELECT sequence FROM sync_context LIMIT 1),
    '${tableName.replaceAll("'", "''")}',
    NEW.${quoteSqliteIdentifier("id")},
    (SELECT capture_action_record_id FROM sync_context LIMIT 1),
    'UPDATE',
    ${jsonPatchChain("NEW")},
    ${jsonPatchChain("OLD")},
    (SELECT sequence FROM sync_context LIMIT 1)
  );

  UPDATE sync_context SET sequence = sequence + 1;
END;
`

				yield* sql.unsafe(`DROP TRIGGER IF EXISTS ${quoteSqliteIdentifier(triggerInsertName)}`).raw
				yield* sql.unsafe(insertTriggerSql).raw

				yield* sql.unsafe(`DROP TRIGGER IF EXISTS ${quoteSqliteIdentifier(triggerUpdateName)}`).raw
				yield* sql.unsafe(updateTriggerSql).raw

				yield* sql.unsafe(`DROP TRIGGER IF EXISTS ${quoteSqliteIdentifier(triggerDeleteName)}`).raw
				yield* sql.unsafe(deleteTriggerSql).raw

				yield* Effect.logInfo(`SQLite patch triggers installed for table: ${tableName}`)
			})

		const installPatchCapture = (
			tableNames: ReadonlyArray<string>
		): Effect.Effect<void, SqlError.SqlError | Error> =>
			Effect.all(
				Array.from(tableNames).map((t) => createSqlitePatchTriggersForTable(t)),
				{ concurrency: 1 }
			).pipe(Effect.asVoid)

		const setCaptureContext = (
			actionRecordId: string | null
		): Effect.Effect<void, SqlError.SqlError | Error> =>
			Effect.gen(function* () {
				yield* sql`
					UPDATE sync_context
					SET capture_action_record_id = ${actionRecordId}, sequence = 0
				`
			})

		const setPatchTrackingEnabled = (
			enabled: boolean
		): Effect.Effect<void, SqlError.SqlError | Error> =>
			Effect.gen(function* () {
				yield* sql`
					UPDATE sync_context
					SET disable_tracking = ${enabled ? 0 : 1}
				`
			})

		const withPatchTrackingDisabled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			setPatchTrackingEnabled(false).pipe(
				Effect.zipRight(effect),
				Effect.ensuring(setPatchTrackingEnabled(true).pipe(Effect.orDie))
			)

		const withCaptureContext = <A, E, R>(actionRecordId: string | null, effect: Effect.Effect<A, E, R>) =>
			setCaptureContext(actionRecordId).pipe(
				Effect.zipRight(effect),
				Effect.ensuring(setCaptureContext(null).pipe(Effect.orDie))
			)

		return {
			dialect: "sqlite",
			initializeSyncSchema,
			installPatchCapture,
			setCaptureContext,
			setPatchTrackingEnabled,
			withPatchTrackingDisabled,
			withCaptureContext
		} as const
	})
)
