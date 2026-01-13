# Synchrotron Multi-DB Plan: DB Adapter Abstraction

## Motivation

Synchrotron’s offline properties depend on database behavior being deterministic during replay:

- **Deterministic ID generation** for inserts (no coordination, no conflicts).
- **Automatic patch capture** for all writes performed inside actions (unrestricted SQL).
- **Rollback + replay** driven by the patch log (ActionModifiedRows).
- **Stable ordering** via Hybrid Logical Clocks (HLC) and an index-friendly replay-order key `(clock_time_ms, clock_counter, client_id, id)`.

Today, the local engine relies heavily on PostgreSQL semantics via PGlite:

- PL/pgSQL functions + triggers for patch capture and rollback (e.g. `packages/sync-core/src/db/sql/patch/*`, `packages/sync-core/src/db/sql/action/*`, `packages/sync-core/src/db/sql/amr/*`).
- PostgreSQL session settings (`set_config` / `current_setting`) to pass per-transaction context into triggers (e.g. `packages/sync-core/src/SyncService.ts`).
- PostgreSQL-only primitives (`txid_current()`, `jsonb_*`, `uuid-ossp`, catalog queries).

To support multiple **client-side** databases (PGlite and SQLite), we need a **clear adapter boundary** so that:

- Core sync logic is mostly database-agnostic TypeScript.
- Database-specific functionality is isolated behind a minimal, capability-driven interface.
- Client backend swaps (PGlite ↔ SQLite) don’t silently break determinism.

## Scope (updated)

These refinements assume:

- **Server is always PostgreSQL** (required for server-side concerns like RLS and Electric’s Postgres source of truth).
- We are **only abstracting the client-local database backend**:
  - Current: PGlite (Postgres-in-WASM)
  - Target: SQLite (via Electric SQL’s SQLite support)
- The client must remain compatible with the existing server protocol and schema (ActionRecords + ActionModifiedRows).

## Goals

1. **Support multiple local DB backends** without changing the “unrestricted SQL in actions” programming model.
2. **Preserve offline determinism**: same action record + same starting state ⇒ same resulting state.
3. **Allow future backends** (SQLite/WASM, Node SQLite, etc.) with predictable requirements.
4. **Make invariants testable**: run the sync-core test suite (or a portable subset) against multiple adapters.

## Non-goals (initially)

- Matching every Postgres type feature in SQLite (arrays, JSONB, timestamptz casting, etc.).
- Supporting “mixed schema types” with automatic lossless conversion across DBs (this can come later).
- Abstracting or replacing the server-side PostgreSQL requirement.

## Key invariants the adapter must preserve

### 1) Deterministic ID generation

Requirement:

- Inserts into synced tables must produce the same `id` on every client during replay.
- Actions must not manually assign ids (Synchrotron owns ids), but internal patch-apply may need to insert with explicit ids.

Today:

- `generate_deterministic_id()` uses `sync.current_action_record_id` + a content hash + collision map (`packages/sync-core/src/db/sql/pglite/archive/deterministic_id_trigger.sql`).
- Context is set by the engine: `set_config('sync.current_action_record_id', ...)` (`packages/sync-core/src/SyncService.ts`).

Adapter implications:

- Must provide a reliable way to pass “current action id for id-generation” into triggers/UDFs.
- Must support an **internal mode** where inserts with explicit ids are allowed (patch apply), without letting user actions bypass the rule.

### 2) Patch capture for unrestricted SQL

Requirement:

- Any INSERT/UPDATE/DELETE inside an action must be captured as ActionModifiedRows without requiring the action author to do anything special.

Today:

- An AFTER trigger calls `generate_patches()` and stores diffs into `action_modified_rows` using the transaction’s action record (`txid_current()`) (`packages/sync-core/src/db/sql/patch/generate_patches.ts`).
- During apply/replay, patches for a batch are attributed to a single placeholder record (`_InternalSyncApply`) and compared to the incoming patches (`packages/sync-core/src/SyncService.ts`).

Adapter implications:

- Needs a stable concept of “tracking action id” for patch capture (which is *not always* the action id used for deterministic IDs).
- Must support sequence numbering per tracked action record.

### 3) Rollback + replay correctness

Requirement:

- Must be able to rollback to a common ancestor by applying reverse patches in exact reverse order (including per-action ordering).

Today:

- `rollback_to_action` is PL/pgSQL and applies `apply_reverse_amr_batch` (`packages/sync-core/src/db/sql/action/rollback_to_action.ts`).

Adapter implications:

- Either provide backend-specific stored procedures, or move rollback to TypeScript so it’s shared across DBs.

### 4) Stable ordering (HLC)

Requirement:

- Actions must be totally ordered in a stable way across all nodes.

Today:

- `action_records.clock_time_ms` and `action_records.clock_counter` are computed on insert/update from `clock` + `client_id` (`packages/sync-core/src/db/sql/schema/create_sync_tables.ts`).
- Server/client ordering uses `ORDER BY clock_time_ms, clock_counter, client_id, id` (btree index-friendly).
- Some queries still rely on `compare_hlc` (`packages/sync-core/src/db/sql/clock/compare_hlc.ts`) as a causal filter.

Adapter implications:

- Ensure every backend can derive `clock_time_ms` / `clock_counter` consistently from the same logical clock spec.
- Avoid JSONB-heavy ordering/comparisons inside queries; rely on stored scalars for ordering and pagination.

## Design principle: split DB responsibilities

### A) Must be in the DB (because actions are arbitrary SQL)

- Deterministic id assignment for INSERTs into synced tables.
- Patch capture triggers for INSERT/UPDATE/DELETE on synced tables.
- Minimal tables/indexes needed for sync metadata.

### B) Should move to TypeScript (for portability)

- `rollback_to_action`, `find_common_ancestor` (implemented via queries + TS control flow).
- Applying patches forward/reverse (read AMRs + execute parameterized statements).
- Sorting/merging clocks and replay-order key computation.
- “Trigger context” management (implemented using portable tables rather than Postgres settings when possible).

This reduces stored-procedure surface area and makes SQLite feasible.

## Proposed adapter boundary

### Core interfaces (conceptual)

The sync engine (SyncService + repos) should depend on a narrow adapter instead of raw SQL functions:

```ts
// Client-only scope: server remains Postgres.
export type ClientDbBackend = "pglite" | "sqlite";

export interface SyncDbAdapter {
  readonly backend: ClientDbBackend;
  // Consider also exposing the @effect/sql dialect name for sql.onDialect usage:
  // readonly dialect: "pg" | "sqlite";

  // Schema/bootstrap
  initializeSyncSchema: Effect<void>;
  installSyncTriggers: (tables: readonly string[]) => Effect<void>;
  validateSyncedTables: (tables: readonly string[]) => Effect<void>;

  // Transactions & trigger context
  withTransaction: <A, E, R>(fa: Effect<A, E, R>) => Effect<A, E, R>;
  setIdGenerationContext: (actionRecordId: string) => Effect<void>;
  setPatchTrackingContext: (trackingActionRecordId: string) => Effect<void>;
  setTriggerMode: (mode: "normal" | "applyPatches" | "rollback" | "disabled") => Effect<void>;

  // Query utilities
  computeSortableClock: (clock: HLC) => string;

  // Patch/rollback primitives (portable TS implementation can live behind these)
  getAmrsForActionIds: (actionIds: readonly string[]) => Effect<readonly ActionModifiedRow[]>;
  getAmrsForTrackingAction: (trackingActionId: string) => Effect<readonly ActionModifiedRow[]>;
  applyForwardAmrs: (amrIds: readonly string[]) => Effect<void>;
  applyReverseAmrs: (amrIds: readonly string[]) => Effect<void>;
  rollbackToAction: (actionIdOrNull: string | null) => Effect<void>;
  findCommonAncestor: () => Effect<Option<ActionRecord>>;
}
```

Notes:

- This interface is intentionally *behavioral* rather than “SQL feature mapping”.
- The adapter can implement methods either in SQL (Postgres) or in TypeScript (SQLite) as long as invariants hold.

### Capability flags (optional but recommended)

Some backends may not support all features equally. Add capabilities so the engine can fail fast with a clear error:

```ts
export interface SyncDbCapabilities {
  hasTriggers: boolean;
  canAssignIdInTrigger: boolean; // SQLite needs a pattern workaround
  hasJsonFunctions: boolean;     // e.g. SQLite JSON1
  hasSessionVariables: boolean;  // Postgres set_config/current_setting
}
```

## Critical design decision: cross-backend interoperability

If a dataset might have:

- SQLite clients and Postgres/PGlite clients, or
- SQLite clients + Postgres server applying patches,

then **deterministic ids and patch encoding must be compatible across DBs**.

This implies:

1. **Define a backend-agnostic spec** for content hashing (no reliance on Postgres `jsonb::text` formatting).
2. **Define a backend-agnostic encoding** for patch values (types, nulls, dates, arrays).

If we do *not* enforce compatibility, we must explicitly require “all clients for a dataset use the same backend”, which is usually an unacceptable product constraint.

## Deterministic ID spec (proposed)

### Requirements

- Stable across backends, runtimes, and versions.
- Does not depend on database JSON serialization quirks.
- Handles collisions when identical rows are inserted multiple times in the same action/transaction.

### Proposed canonical input

Define a canonical string `S`:

```
S = tableName + "\u001f" + concat(
  for each column in deterministicColumnOrder(excluding "id"):
    columnName + "=" + canonicalValue(columnValue) + "\u001e"
)
```

Where:

- `deterministicColumnOrder` is the schema’s column order at trigger-install time (or sorted order, but must match across DBs).
- `canonicalValue` is an explicit, backend-agnostic encoding:
  - `NULL` → `"null"`
  - booleans → `"true"|"false"`
  - numbers → decimal string with no trailing `.0` normalization surprises (define exact rules)
  - strings → UTF-8 with escaping (or use JSON string encoding)
  - structured values → require storing as JSON *text* and treat it as an opaque string (initially)

Then:

- `contentHash = sha256(S)` (or blake3) as hex/base64.
- `name = contentHash` for the first insert of that content in the action; append `_<n>` for collisions within the same action.
- `id = uuidv5(namespace = actionRecordId, name = name)` OR `id = sha256(actionRecordId + ":" + name)` truncated to 16 bytes.

### Implementation approach

To keep actions unrestricted:

- Implement id generation in triggers for each synced table.
- Pass `actionRecordId` (namespace) via adapter context.
- Maintain a per-transaction collision counter keyed by `contentHash`.

Backends:

- **Postgres/PGlite**: generated trigger code can compute `S` directly from `NEW.col` values; avoid `to_jsonb(NEW)::text`.
- **SQLite**: use generated triggers + a temp collision table; may require UDFs for `sha256`/`uuidv5`.

## Patch encoding spec (proposed)

Patch interoperability requires that the server (often Postgres) can apply patches generated by clients (possibly SQLite).

### Minimal viable plan (Phase 1)

- Treat all patch values as JSON-compatible scalars or JSON text.
- Strongly recommend portable column types for synced app tables:
  - `id` as TEXT
  - timestamps as INTEGER (ms since epoch) or TEXT ISO8601 (pick one)
  - arrays/objects stored as JSON TEXT (not Postgres arrays)
- Store `forward_patches` / `reverse_patches` as JSON text in backends that don’t support JSONB.

This is the fastest path to “works on SQLite”, but requires schema conventions.

### Full compatibility plan (Phase 2)

Introduce typed patch values:

```json
{
  "colA": { "t": "text", "v": "hello" },
  "colB": { "t": "int64", "v": "1700000000000" },
  "colC": { "t": "json", "v": "{\"x\":1}" }
}
```

Then adapter applies conversions per backend/column type.

This supports richer schemas but increases complexity and patch size.

## SQLite-specific notes (known hard parts)

1. **No PL/pgSQL**: dynamic trigger generation and loops must move to TypeScript.
2. **Trigger assignment limitations**: SQLite triggers can’t reliably mutate `NEW.*` like Postgres. Use one of:
   - “INSERT computed row + RAISE(IGNORE)” pattern for id assignment
   - or “INSTEAD OF INSERT on view” (requires inserting into a view, which conflicts with “unrestricted SQL”)
3. **No session variables**: implement trigger context via `TEMP` tables:
   - `sync_context(id_generation_action_id, patch_tracking_action_id, trigger_mode, ...)`
   - `sync_collision_map(content_hash PRIMARY KEY, counter INTEGER)`
4. **JSON support**: prefer requiring JSON1; otherwise treat patches as TEXT and do encoding/decoding in TS.

## Electric SQL implications (client-side)

Electric already supports **multiple local engines** (PGlite and SQLite). For Synchrotron, this impacts client architecture in two ways:

1. **Local DB must be compatible with Electric’s local ingestion path**
   - Electric shape updates insert into `action_records` and `action_modified_rows`.
   - Our schema and constraints must be compatible with Electric’s insert/update strategy (usually `INSERT ... ON CONFLICT DO NOTHING` / upserts).

2. **Trigger behavior must not “double-count” Electric writes**
   - Today we only apply sync triggers to application tables (e.g. `todos`), not to the action log tables.
   - If we ever sync application tables directly via Electric in addition to syncing the action log, we must ensure:
     - Electric-applied remote changes do not generate new local AMRs as if they were user actions.
     - This likely requires a robust “trigger mode” concept (normal vs. apply vs. disabled) that works on both PGlite and SQLite.

3. **Expect different client-side APIs per engine**
   - Today the example app uses PGlite-specific extras (e.g. live queries via `@electric-sql/pglite/live`).
   - For SQLite, Electric may expose different primitives/packages; isolate these differences inside `sync-client` so `sync-core` stays backend-agnostic.

## Server contract (out of scope, but constraining)

Even though server-side Postgres is fixed and out of scope to abstract, it constrains the client adapter work:

- **Action log compatibility**: SQLite clients must produce ActionRecords/AMRs the server can store and replay to other clients.
- **Patch encoding compatibility**: patches generated by SQLite clients must be compatible with the server’s schema types and patch-apply logic.
- If any server logic relies on Postgres-specific types (e.g. arrays, JSONB), we either:
  - constrain synced app tables to portable types, or
  - define a typed patch encoding that lets the server perform correct casts.

## Effect architecture & code organization

We should lean into Effect’s strengths so that swapping backends is primarily a **Layer wiring change**, not a rewrite.

### 1) Depend on `SqlClient` in sync-core (not a concrete driver)

- Prefer `SqlClient.SqlClient` as the database dependency in `sync-core` services.
- Avoid importing `PgLiteClient` directly inside `sync-core` (today `SyncService` does), so SQLite can provide the same service contract by swapping Layers.

### 2) Provide a client DB adapter as an Effect service

- Implement `SyncDbAdapter` as an Effect service/tag that depends on `SqlClient`.
- `sync-core` owns the interface (and any portable TS implementations).
- `sync-client` owns the concrete Layer that selects which adapter + driver to provide.

### 3) Use `Layer`-based driver swapping

Effect SQL drivers provide Layers that furnish `SqlClient`:

- Postgres dialect (PGlite): provided by `@effect/sql-pglite` (already in this repo).
- SQLite dialect: likely via an `@effect/sql-sqlite-*` package (node/wasm), or a small custom driver wrapper if Electric’s SQLite runtime doesn’t map 1:1.

The key pattern is: application code requires `SqlClient` and remains dialect-agnostic; the chosen driver Layer decides the backend.

### 4) Dialect-specific SQL via `sql.onDialect`

For small SQL differences, prefer `sql.onDialect({ pg: ..., sqlite: ... })` to avoid exploding the adapter surface area.

Use it for:

- context setting (session variables on PGlite vs temp tables on SQLite)
- trigger DDL differences
- JSON/text encoding differences

### 5) Schema + models: be explicit about portable representations

`ActionRecord` / `ActionModifiedRow` use `Schema` types that imply JSON-capable columns. For SQLite:

- decide whether to store `clock`, `args`, and patches as:
  - JSON (via JSON1 / driver-level JSON support), or
  - TEXT with explicit encode/decode at the repo boundary
- make that decision explicit in the adapter and model codecs so behavior is deterministic and testable.

### 6) Layer wiring sketch (client)

Target state: `sync-core` services (SyncService, repos, db utilities) only depend on `SqlClient` + `SyncDbAdapter`, while `sync-client` chooses which concrete driver to provide.

Pseudo-wiring:

```ts
// sync-client
export const makeSynchrotronClientLayer = (config: Partial<SynchrotronClientConfigData>) => {
  const configLayer = createSynchrotronConfig(config)

  const dbLayer = Layer.unwrapEffect(
    Effect.gen(function* () {
      const cfg = yield* SynchrotronClientConfig
      return cfg.clientDb === "sqlite" ? SqliteClientLive : PgLiteClientLive
    })
  )

  return SyncDbAdapterLive.pipe(
    Layer.provideMerge(dbLayer),
    Layer.provideMerge(SyncService.Default),
    Layer.provideMerge(ActionRecordRepo.Default),
    Layer.provideMerge(ActionModifiedRowRepo.Default),
    Layer.provideMerge(ActionRegistry.Default),
    Layer.provideMerge(ClockService.Default),
    Layer.provideMerge(configLayer)
  )
}
```

Key point: only `dbLayer` changes; the rest of the graph stays stable.

### 7) Proposed module layout

Keep the interface and portable logic in `sync-core`, and backend-specific pieces in `sync-client`:

- `packages/sync-core/src/db/adapter/SyncDbAdapter.ts` (tag + interface + errors)
- `packages/sync-core/src/db/adapter/portable/*` (TS rollback/apply/common-ancestor utilities)
- `packages/sync-client/src/db/pglite/*` (PGlite driver Layer + PGlite adapter impl)
- `packages/sync-client/src/db/sqlite/*` (SQLite driver Layer + SQLite adapter impl)
- `packages/sync-client/src/electric/*` (Electric integration that depends only on `SqlClient`)

## Proposed implementation phases

### Phase 0 — Inventory & invariants (docs + tests)

- Document the exact flows for:
  - `executeAction` (local) (`packages/sync-core/src/SyncService.ts`)
  - `applyActionRecords` (remote apply) (`packages/sync-core/src/SyncService.ts`)
  - rollback/reconcile
- Add a small test matrix spec:
  - “same actions + same start state ⇒ same row ids”
  - “patches generated match replay outcome”

### Phase 1 — Introduce the adapter boundary (no behavior change)

- Create `SyncDbAdapter` interface + default PGlite implementation that wraps existing SQL.
- Update SyncService to call the adapter for:
  - context setting (`set_config` today)
  - trigger installation
  - rollback/common ancestor calls
  - patch apply calls
- Keep the current SQL functions working unchanged behind the adapter.

### Phase 2 — Move portability candidates from SQL to TypeScript

Goal: shrink backend-specific SQL surface.

- Compute the replay-order key in TypeScript and store `clock_time_ms` / `clock_counter` on insert/update of action records.
- Reimplement `find_common_ancestor` in TS using repository queries.
- Reimplement `rollback_to_action` in TS:
  - query action_records newer than target
  - query AMRs for those actions ordered by (clock_time_ms DESC, clock_counter DESC, client_id DESC, id DESC, sequence DESC)
  - apply reverse patches via adapter primitive
  - clean up `local_applied_action_ids`
- Reimplement `apply_forward_amr_batch` / `apply_reverse_amr_batch` in TS (parameterized statements per AMR).

This sets up SQLite without requiring stored procedures.

### Phase 3 — Make deterministic ID + patch capture portable

- Define canonical content hashing spec (see above).
- Replace Postgres `to_jsonb(NEW)::text` hashing with generated per-table trigger logic that matches the spec.
- Replace generic patch functions (`generate_patches`, `handle_*`) with generated per-table triggers OR keep PG as-is but add a SQLite path that matches patch encoding.

Deliverable: a “portable schema + triggers” mode that works on both PG and SQLite.

### Phase 4 — Add SQLite adapter

- Choose a SQLite runtime (browser/wasm vs node) compatible with Electric SQL’s SQLite support and an `@effect/sql` driver (or wrapper).
- Implement:
  - `initializeSyncSchema` with SQLite-compatible DDL for sync tables
  - context tables (TEMP) + collision tracking
  - per-table trigger generation for id + patch capture
  - patch apply and rollback via TS (from Phase 2)
- Add a new test harness that runs the portable test suite against SQLite.

### Phase 5 — Interop & hardening

- Cross-adapter tests:
  - create actions on SQLite client, apply on Postgres server, verify state equality
  - (optional) mixed client backends applying each other’s actions
- Performance checks:
  - trigger cost for write-heavy actions
  - patch size + apply cost
- Document schema portability rules and supported types.

## Open questions / decisions to make early

1. **Do we require mixed-backend interoperability?**
   - If yes: must formalize canonical id + patch encoding and test cross-db.
2. **What portable schema conventions do we enforce?**
   - Especially for timestamps, arrays, and JSON.
3. **Where do we want patch apply to live long-term?**
   - TS-based apply is portable; SQL-based apply may be faster on Postgres.
4. **How do we distinguish “internal patch apply inserts” from “user manual id inserts”?**
   - Likely a dedicated trigger mode flag, not a single “disable everything” flag.

## Success criteria

- Sync-core can run with at least two adapters (PGlite and SQLite) with the same high-level API.
- Deterministic ids are stable and collision-safe.
- Rollback/replay produces identical end states across backends for the same action log.
- Clear documentation exists for supported schema patterns and backend limitations.
