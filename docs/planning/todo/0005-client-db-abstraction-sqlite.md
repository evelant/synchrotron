# 0005 — Client DB Abstraction (SQLite-first, IDs Provided by App)

## Status

Implemented (client DB abstraction complete; examples remain PGlite-first for now)

## Summary

Synchrotron’s client runtime is currently tightly coupled to Postgres semantics (via PGlite): PL/pgSQL functions, JSONB, `txid_current()`, and session variables (`set_config/current_setting`). This blocks stable, widely-available client runtimes (notably React Native) where the practical choice is SQLite.

This plan introduces a **DB-agnostic client DB interface** (as an Effect service) and a **SQLite client dialect** while preserving two core constraints:

1. Actions may execute arbitrary `INSERT/UPDATE/DELETE` SQL (no “must use our repo API” restriction).
2. Row `id`s are provided by the application for all client DBs (via a deterministic ID helper), not by triggers.

Backend remains Postgres-only.

## Goals

- Support SQLite as a client database (browser/desktop/RN via appropriate drivers).
- Preserve “arbitrary SQL writes inside actions” by capturing patches at the DB layer (triggers).
- Make deterministic IDs portable by generating them in TypeScript (action-scoped), not in DB triggers.
- Keep the door open for additional client DBs by formalizing a minimal `ClientDbAdapter` interface as an Effect service.

## Non-goals (for this milestone)

- Replace the server’s Postgres schema or server-side patch application model.
- Perfect cross-database DDL portability for application tables (apps own their table schema).
- Solve all Electric integration nuances for SQLite (stream ingestion can be DB-agnostic, but “auto-sync plugin” parity is not required).

## Key Decisions (Locked In)

### A) IDs are provided by the app (all client DBs)

- Inserts into synced tables must include `id`.
- Synchrotron provides a **deterministic ID helper** so the app does not hand-roll IDs.
- This enables SQLite (which cannot reliably set `NEW.id` in triggers) and removes dependency on `uuid-ossp` / `uuid_generate_v5` / `set_config` for ID generation.

### B) Patch capture stays in the database (via triggers)

- Required to preserve “arbitrary SQL writes” inside actions.
- SQLite implementation must generate per-table triggers that write `action_modified_rows`.

## Proposed Architecture

### New Effect service: `ClientDbAdapter`

A DB-agnostic interface that encapsulates the client-side DB “dialect” concerns needed by sync-core.

Proposed surface (exact names TBD):

- `initializeSyncSchema(): Effect<void>`  
  Creates sync tables + any dialect support objects (e.g. temp context table for SQLite).

- `installPatchCapture(tableNames: ReadonlyArray<string>): Effect<void>`  
  Creates/updates triggers for application tables.

- `setCaptureContext(captureActionRecordId: string): Effect<void>`  
  Sets per-transaction context so triggers can associate new `action_modified_rows` with the _current_ action record that is collecting patches.

- `setPatchTrackingEnabled(enabled: boolean): Effect<void>`  
  Used to disable triggers during rollback/patch-apply phases that must not generate new patches.

- `dialect: "postgres" | "sqlite" | "unknown"` and/or `capabilities`  
  Used for small SQL differences (e.g. insert-ignore syntax) if needed by a TS patch applier.

`SqlClient.SqlClient` remains the general query interface; `ClientDbAdapter` is strictly the “sync runtime dialect adapter”.

### Action-scoped context: `DeterministicId` (implemented)

Deterministic ID generation is provided as an Effect service in TypeScript (not stored procedures / triggers):

- `SyncService` wraps both execute and replay in `deterministicId.withActionContext(actionRecord.id, ...)` (where `const deterministicId = yield* DeterministicId`).
- Action code calls `deterministicId.forRow(tableName, row)` to compute a deterministic UUID.
- A per-action collision counter disambiguates identical inserts within the same action.

### Deterministic ID helper (TypeScript)

Introduce a helper API that action code uses to compute IDs deterministically:

- Inputs: `currentActionId`, a canonical representation of the inserted row content (excluding `id`), and a per-action collision counter.
- Output: deterministic UUID (or deterministic string ID) stable across clients when replaying the same action.

This replaces the Postgres deterministic ID trigger and makes the rule consistent across SQLite/PGlite.

## SQLite Dialect Design (Patch Capture)

SQLite needs a per-connection mechanism for trigger context and a way to compute JSON patches.

### Per-connection context table (TEMP)

Create a TEMP table in `initializeSyncSchema()`:

- `sync_context` (TEMP):
  - `capture_action_record_id TEXT`
  - `sequence INTEGER NOT NULL`
  - `disable_tracking INTEGER NOT NULL` (0/1)

`ClientDbAdapter.setCaptureContext(id)` sets `capture_action_record_id` and resets `sequence = 0`.

`ClientDbAdapter.setPatchTrackingEnabled(false)` sets `disable_tracking = 1` and triggers include a `WHEN disable_tracking = 0` guard.

> Note: SQLite’s `RAISE(FAIL, ...)` does **not** roll back the statement’s changes.  
> The SQLite triggers use `RAISE(ABORT, ...)` so direct writes outside an action fail _and_ the statement is rolled back.

### Trigger generation per table

`installPatchCapture(["todos", ...])` generates 3 triggers per table:

- `AFTER INSERT`:
  - forward patch: full row JSON
  - reverse patch: `{}`

- `AFTER DELETE`:
  - forward patch: `{}`
  - reverse patch: full row JSON (from `OLD`)

- `AFTER UPDATE`:
  - forward patch: JSON object containing only changed columns (including explicit `null`)
  - reverse patch: JSON object containing only changed columns with previous values

Implementation approach for UPDATE patches:

- Build `forward_patches` by starting from `'{}'` and repeatedly `json_patch` in `CASE` blocks:
  - `CASE WHEN OLD.col IS NOT NEW.col THEN json_object('col', NEW.col) ELSE '{}' END`
- Build `reverse_patches` similarly with `OLD.col`.

Sequence handling:

- Insert into `action_modified_rows` with `sequence = sync_context.sequence`.
- Increment `sync_context.sequence` after each trigger invocation.

## Porting Work: Remove PL/pgSQL Runtime Dependencies

SQLite cannot run the current PL/pgSQL functions (`rollback_to_action`, `find_common_ancestor`, `apply_forward_amr`, `apply_reverse_amr`, `compare_hlc` in SQL).

Plan: move these runtime operations into TypeScript and keep SQL usage to:

- regular queries via `SqlClient`
- patch-capture triggers (dialect-specific)

TS implementations (DB-agnostic, use `SqlClient`):

- `findCommonAncestor()` (query + compute based on canonical replay order columns)
- `rollbackToAction(targetActionId | null)` (compute actions to reverse; apply reverse AMRs in correct order; update `local_applied_action_ids`)
- `applyForwardAmrBatch(amrIds)` / `applyReverseAmrBatch(amrIds)` (apply patches using generated SQL)

Small dialect differences (if needed) are handled through `ClientDbAdapter.capabilities` (e.g. “insert ignore” syntax).

## Concrete Implementation Plan (Milestones)

### Milestone 1 — Deterministic IDs in TypeScript (required for SQLite)

- [x] Add `DeterministicId` service and helper API.
- [x] Update `SyncService.executeAction` and remote replay to provide action-scoped ID context.
- [x] Update example app actions (`examples/todo-app-web-pglite/src/actions.ts`) to generate IDs before inserts.
- [x] Update tests that relied on trigger-generated IDs.
- [x] Update docs (`README.md`, `DESIGN.md`) to reflect app-provided IDs + TS generation.

### Milestone 2 — Introduce `ClientDbAdapter` Effect service + refactor sync-core to depend on it

1. Define `ClientDbAdapter` interface in `packages/sync-core` (no PGlite types).
2. Refactor `packages/sync-core/src/SyncService.ts` to:
   - depend on `SqlClient.SqlClient` (not `PgLiteClient`)
   - call `ClientDbAdapter.setCaptureContext(...)` instead of Postgres `set_config(...)`
   - use `ClientDbAdapter.setPatchTrackingEnabled(false)` during rollback paths
3. Provide the correct `ClientDbAdapter` implementation in the client layer (`PostgresClientDbAdapter` for PGlite/Postgres, `SqliteClientDbAdapter` for SQLite).

### Milestone 3 — Replace PL/pgSQL runtime functions with TypeScript implementations

1. Implement TS patch applier (forward/reverse) with minimal dialect hooks.
2. Implement TS `rollbackToAction` and TS `findCommonAncestor`.
3. Stop creating/depending on server-only PL/pgSQL runtime functions in client initialization (use `initializeClientDatabaseSchema` / `ClientDbAdapter.initializeSyncSchema`).
4. Keep Postgres server-side behavior unchanged (server can still apply patches in SQL).

### Milestone 4 — SQLite dialect: schema + patch capture triggers

1. Add a SQLite `ClientDbAdapter` implementation (`SqliteClientDbAdapter`):
   - create sync tables with SQLite types (JSON stored as TEXT)
   - create `TEMP sync_context` and implement capture/tracking toggles
   - generate per-table patch capture triggers
2. Add a SQLite driver/layer (choose one per target platform):
   - Node tests: `better-sqlite3` / `sqlite3` driver via an Effect `SqlClient` adapter
   - Browser: `@effect/sql-sqlite-wasm` (WASM SQLite)
   - React Native: `@op-engineering/op-sqlite` via a small local `@effect/sql` adapter (`@synchrotron/sync-client`), since `@effect/sql-sqlite-react-native` is not compatible with the pinned `op-sqlite` result shape.
3. Add test coverage:
   - patch capture correctness (INSERT/UPDATE/DELETE + sequence)
   - rollback correctness using TS runtime
   - deterministic ID stability across replay

Milestone 4 notes (implemented):

- SQLite tests run via `@effect/sql-sqlite-node` (better-sqlite3) in `packages/sync-core/test/sqlite-clientdb.test.ts`.
  - `@effect/sql-sqlite-wasm` is still the intended browser runtime, but isn’t reliable to execute under Node-based tests in this repo.
- SQLite drivers cannot bind `Date` / `boolean` values directly. To keep client DBs portable:
  - `action_records.created_at` is stored as an ISO string.
  - `action_records.synced` is stored as `INTEGER` (`0 | 1`) in both Postgres and SQLite (decoded to boolean in the model).
  - Patch application coerces booleans to `0 | 1` when running on SQLite.
- `action_records.id` is generated by the app/runtime (not DB defaults) so it works on SQLite.

### Milestone 5 — Make ingestion/network DB-agnostic (where needed)

1. Ensure `ElectricSyncService` only depends on `SqlClient` (remove `PgLiteClient` dependency) so it can insert streamed rows into any client DB.
2. Validate that JSON encoding/decoding of `clock` and `args` works across dialects.
3. (Optional) Provide a non-Electric `SyncNetworkService` implementation for environments where Electric is unavailable.

Milestone 5 notes (implemented):

- `packages/sync-client/src/electric/ElectricSyncService.ts` now depends on `SqlClient` (not `PgLiteClient`) and inserts JSON fields as strings so it can target SQLite-backed clients too.
- Replicated `action_records.synced` is treated as `0 | 1` (and `created_at` is inserted as an ISO string), matching the portability rules introduced in Milestone 4.
- `packages/sync-client/src/SyncNetworkService.ts` is configurable via `SynchrotronClientConfig.syncRpcUrl` / `SYNC_RPC_URL` (default: `http://localhost:3010/rpc`).

## Acceptance Criteria

- Existing `packages/sync-core` tests continue to pass on PGlite.
- A new SQLite test suite validates:
  - patch capture triggers produce the expected `action_modified_rows`
  - TS rollback + replay produces the same final state
  - deterministic IDs are stable across clients/replay
- Example todo app runs with PGlite; a SQLite-backed example is deferred to a follow-up.
- `README.md` + `DESIGN.md` reflect the new ID rule and the DB abstraction boundary once Milestone 1 lands.

## Open Questions / Risks

- JSON handling in SQLite: store as TEXT; ensure consistent encode/decode in repositories/models.
- Column-type portability: Postgres arrays (e.g. `tags text[]`) are not portable; prefer JSON columns for cross-client schemas.
- Trigger maintenance: implemented via `PRAGMA table_info` introspection; schema migrations that change tracked table columns should re-run `installPatchCapture` to drop/recreate triggers.
- Performance: JSON patch generation in SQLite triggers may be slower than Postgres; measure and optimize later (potentially via native extension).
