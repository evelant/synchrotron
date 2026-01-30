# Design

Synchrotron is an offline-first sync system for Postgres that converges by replaying deterministic business-logic actions.

Instead of syncing table/row patches as the source of truth (usually with last-write-wins semantics), Synchrotron syncs an operation log: actions + their arguments + a Hybrid Logical Clock (HLC). When histories diverge, clients roll back to a common ancestor and replay actions in total order. Row-level patches still exist, but only to make rollback/fast-forward cheap and to detect when replay produces a different outcome.

## Goals

- Offline-first writes against a local database
- Intention preservation through business-logic replay
- Deterministic total ordering using HLCs
- Performance: bound log growth and minimize transfer
- Minimal server logic; client-side reconciliation
- Security via PostgreSQL Row Level Security (RLS)
- Eventual convergence (including private-data divergence)

## Concepts

- Action: a deterministic mutation function that can read/write the database.
- Action record (`action_records`): an immutable log entry for one action execution.
  - `_tag`: action identifier (treat as versioned API)
  - `args`: serialized arguments (captures non-determinism)
  - `client_id`: origin
  - `clock`: HLC for ordering (JSON; JSONB on Postgres/PGlite, JSON strings on SQLite)
  - `transaction_id`: app-provided execution identifier (number), not a DB-specific txid
- Action modified row (`action_modified_rows`): per-row patch records captured by triggers during the action transaction (includes an application-defined `audience_key` scope token for RLS filtering).
- Execute vs apply:
  - Execute: run an action and create a new action record + patches.
  - Apply: replay an existing action record without creating a new record.
- CORRECTION action: a system action record whose patches represent the delta between the incoming patches and what a local replay produced (typically due to private data / conditionals).
- ROLLBACK action: a system marker that tells replicas to roll back to a specific ancestor action before replaying.
- HLC details:
  - `timestamp`: physical time (ms)
  - `vector`: map of `client_id -> counter` used for causality hints
  - local mutation increments the local counter
  - receiving remote clocks merges vectors by max; entries never reset
- uploads include `basisServerIngestId` (client's last seen `server_ingest_id` cursor); the server rejects uploads when the client is behind the server ingestion head (fetch+reconcile+retry; `performSync()` does a small bounded retry; RPC error `_tag` = `SendLocalActionsBehindHead`)

## Data model

`action_records` (append-only):

- `id` (text UUID)
- `server_ingest_id` (BIGINT, server-assigned; monotonic fetch cursor)
- `_tag`, `client_id`, `transaction_id`, `created_at`, `synced`
- `clock` (HLC JSON) plus derived ordering columns: `clock_time_ms`, `clock_counter`
- `args` (JSON; includes `timestamp`)

Notes on portability:

- JSON values are encoded as JSON strings on insert/update and decoded from either JSONB objects (Postgres/PGlite) or strings (SQLite).
- `action_records.clock` must be a JSON object; the Postgres trigger rejects JSONB strings (they indicate accidental double-encoding).
- SQLite patch capture encodes columns declared with `BOOLEAN` affinity as JSON booleans (`true/false`) so patches can be applied to Postgres boolean columns without type errors.
- SQLite drivers typically can’t bind JS booleans directly; Synchrotron coerces bound boolean parameters (`true/false`) to `1/0` at execution time.
- `synced` is stored as an integer `0 | 1` in the database (decoded as a boolean in TypeScript).
- Postgres drivers often return `BIGINT` / `INT8` columns as strings; these are decoded into numbers in TypeScript.

`action_modified_rows`:

- `id`
- `action_record_id` (FK)
- `table_name`, `row_id`
- `audience_key`: application-defined visibility scope token (copied from the base table’s `audience_key`; used for fast RLS filtering, especially for shared/collaborative rows)
- `operation`: `INSERT` | `UPDATE` | `DELETE`
- `forward_patches`, `reverse_patches` (JSON)
- `sequence`: monotonic per action record (preserves intra-transaction order)

Client-side:

- `client_sync_status`: `current_clock`, `last_synced_clock`, `last_seen_server_ingest_id`
- `local_applied_action_ids`: action ids already applied locally

Backend state:

- Clients reconcile by computing a common ancestor, rolling back, and replaying actions; patch-apply and rollback are implemented in TypeScript so the client DB can be swapped (e.g. SQLite).
- The server materializes state by applying forward patches in HLC order (Postgres SQL functions) and applies rollbacks so that patch application order matches clients.

## Components

- Action registry: maps `_tag` -> action implementation (today: `ActionRegistry.defineAction(tag, argsSchema, fn)` validates/decodes args via Effect Schema and injects a `timestamp` for recording + replay).
- Database access layer: built on `@effect/sql` models/repositories.
- Sync engine (`SyncService`): implemented as internal modules under `packages/sync-core/src/sync/` and wired in `packages/sync-core/src/SyncService.ts`.
- Server runtime (`SyncServerService`): implemented as internal modules under `packages/sync-server/src/server/` and wired in `packages/sync-server/src/SyncServerService.ts`.
- Client runtime layers (`@synchrotron/sync-client`): PGlite + SQLite (WASM) layers are exported from the main entrypoint; the SQLite (React Native) layer lives at `@synchrotron/sync-client/react-native` and uses `@effect/sql-sqlite-react-native` (native, backed by `@op-engineering/op-sqlite`) and `@effect/sql-sqlite-wasm` on web via a platform-specific `.web.ts` module.
  - Repo note: `@effect/sql-sqlite-react-native` is currently patched via pnpm `patchedDependencies` for `@op-engineering/op-sqlite@15.x` compatibility (see `patches/@effect__sql-sqlite-react-native.patch`).
  - Repo note: `@effect/sql-sqlite-wasm` is patched via pnpm `patchedDependencies` to provide a `locateFile` override for Metro / React Native Web wasm loading (SqliteClient + OpfsWorker), to fail fast on OPFS worker startup errors instead of hanging on the `ready` handshake, and to avoid a `connectionRef` TDZ crash if the worker errors before initialization (see `patches/@effect__sql-sqlite-wasm.patch`). The RN example copies `wa-sqlite.wasm` into `examples/todo-app-react-native-sqlite/public/` (via `postinstall`) so web can load it from `/wa-sqlite.wasm`. On web we persist SQLite using OPFS via `@effect/sql-sqlite-wasm`'s `OpfsWorker`.
- Client DB adapter (`ClientDbAdapter`): encapsulates client-side DB dialect concerns needed by `sync-core` (schema init, trigger context, patch tracking toggles, and trigger installation). Implementations include `PostgresClientDbAdapter` and `SqliteClientDbAdapter`.
- Sync transport (`SyncNetworkService`): sync-core defines the transport contract (no built-in live implementation); client runtimes provide concrete layers (HTTP RPC, Electric ingress, tests). The transport uploads local unsynced actions/AMRs and fetches remote sync-log batches. `sync-core` owns the table-write ingestion step (idempotent upserts into `action_records` / `action_modified_rows`) so transports don’t need to implement DB-specific insertion logic. In Electric-enabled clients, remote ingress is owned by `ElectricSyncService` and `fetchRemoteActions()` is metadata-only (epoch/retention) to avoid “two ingress writers”.
- Trigger system:
  - patch generation triggers (AFTER INSERT/UPDATE/DELETE) that write `action_modified_rows`
  - triggers associate patches with the currently executing action via a per-transaction capture context (`action_record_id`) (Postgres/PGlite: `set_config/current_setting`, SQLite: `TEMP sync_context`)
  - if capture context is missing, triggers raise an error (prevents untracked writes to synced tables)
  - SQLite triggers are generated from the current table schema; call `ClientDbAdapter.installPatchCapture` after schema migrations that change tracked table columns
  - patch capture can be disabled transaction-locally (`sync.disable_trigger`) during rollback / patch-apply phases
- Clock/identity: `HLC.ts` + `ClockOrder.ts` are pure (merge + canonical ordering by `(clock_time_ms, clock_counter, client_id, id)`); `ActionLogOrder.ts` provides the same ordering at the DB layer (order columns + predecessor queries) so client/server rollback+replay planning can share one implementation; client runtimes provide `ClientIdentity` (stable `clientId`) and `ClientClockState` (persists HLC + cursors in `client_sync_status`); the server derives `server_epoch` / `serverClock` via `ServerMetaService`.
- Electric SQL integration: streams `action_records` and `action_modified_rows` using a reliable receipt cursor (`server_ingest_id`) and up-to-date signals so a transaction's full set of patches arrives before applying.

## Observability

- Sync phases are instrumented with `Effect.withSpan(...)` and log annotations (for example: `clientId`, `syncSessionId`, `applyBatchId`, `sendBatchId`) so logs can be correlated across fetch/apply/send/reconcile. In development, these spans can be exported via OpenTelemetry (see `@synchrotron/observability` + the example backend).
- Example apps can also export Effect logs to Loki via OTLP (enable with `*_OTEL_LOGS_ENABLED=true`).
- The PGlite `@effect/sql` adapter logs all executed SQL statements at `TRACE` (`pglite.statement.*`) to make it easier to follow replay and patch application.
- Client/server transport emits structured logs (`sync.network.*`, `rpc.*`) including action + AMR counts and CORRECTION delta previews.

## Deterministic row IDs

Synced tables require app-provided `id`s. To keep replay deterministic across client databases, Synchrotron generates row IDs in TypeScript (not via DB triggers):

- `SyncService` wraps action execution/replay in `deterministicId.withActionContext(actionRecord.id, ...)` (where `const deterministicId = yield* DeterministicId`).
- Actions call `deterministicId.forRow(tableName, row)` to compute a UUIDv5 from:
  - the table name
  - a canonical JSON representation of the row content (excluding `id`)
  - a per-action collision counter (so identical inserts within one action remain unique)
- The collision counter is maintained in-memory per action replay/execute, not in the database.

Result: replaying the same action record on different clients produces the same inserted row IDs.

## Requirements for actions

- Deterministic: same args + same DB state => same writes.
- Explicit non-determinism: pass time/random/network results/user context as args; `timestamp` is injected automatically.
- No external reads during execution.
- Immutable definitions: never change an action's meaning in-place; version via `_tag` (e.g. `create_todo_v1`).
- Scoped queries: treat actions like API endpoints; always filter by user/tenant context so replay can't touch unrelated rows.

## Executing an action

1. Begin a DB transaction.
2. Insert an `action_records` row (recording an app-provided `transaction_id`).
3. Run the action function (with `DeterministicId` scoped to the action record id).
4. AFTER triggers append `action_modified_rows` for every insert/update/delete (with increasing `sequence`) and associate them to the action via the capture context (`action_record_id`).
5. Commit (or roll back on error).

## Sync and convergence

### Normal sync (no conflicts)

1. `action_records` and `action_modified_rows` replicate via Electric SQL (filtered by RLS).
2. Client applies incoming actions in HLC order.
3. A placeholder CORRECTION action captures the patches produced by local replay of the incoming batch.
4. The client computes a CORRECTION delta: `P_replay(batch) − P_known(batch)` where `P_known` includes the received base patches plus any received CORRECTION patches.
5. If the delta is empty, the placeholder is deleted (no outgoing CORRECTION). If non-empty, the placeholder is kept as a new local CORRECTION action to be uploaded (clocked after all observed remote actions in that apply pass).

### CORRECTION actions (private data / conditional logic)

Replaying an action can legitimately produce different writes when:

- branches depend on rows the client cannot see (RLS),
- logic is conditional on private state.

When patch comparison finds a mismatch, the client may emit a CORRECTION action record (patch-only) to reconcile outcomes. In the common case (private-data divergence), CORRECTION is intended to be additive: it adds missing row/field effects that were not present in the received patch set due to partial visibility. Incoming CORRECTION actions are applied directly as patches (no action code to run).

However, reconciliation deltas are not guaranteed to be purely additive: late-arriving actions and rollback+replay can legitimately change what an earlier action “should have done” in canonical replay order, which can supersede previously-known effects (including prior CORRECTION patches). The key requirement is that replicas reach a fixed point once they have applied the same history; repeated non-convergence for the same basis indicates action impurity (nondeterminism) or an unsupported shared-row divergence case.

### Conflict detection

A conflict exists when incoming actions are not strictly after the client's local unsynced actions. Use HLC/vector causality to detect "happened-before" vs concurrent:

- if everything incoming is after local pending actions, fast-forward
- if anything incoming is concurrent with (or before) local pending actions, reconcile

### Reconciliation (rollback + replay)

1. Identify the common ancestor (latest fully-synced action before divergence).
2. Start a transaction.
3. Roll back to the ancestor by undoing `action_modified_rows` in reverse `sequence` order without recording patches.
4. Insert a single ROLLBACK marker that references the ancestor action id.
5. Replay all actions from that point to "now" in total HLC order, using the same apply+CORRECTION logic as the fast-forward case.
6. Send any new actions (ROLLBACK marker + CORRECTION deltas) to the server.
7. If rejected due to newer actions, abort and retry with the updated history.
8. Commit.

Analogy: this is a bit like Git. Find the merge base (common ancestor), rewind to it, then replay commits to produce a single history. The difference is we replay deterministic action code (not patch hunks), and the order comes from HLC.

### Common sync cases

- No local pending actions, incoming actions exist: apply; emit CORRECTION only if patch diff exists.
- Local pending actions, no incoming: send local actions; mark as synced when accepted.
- Incoming actions that interleave with local pending: reconcile (rollback + replay).
- Incoming rollback markers: roll back to the oldest referenced ancestor once, then apply forward patches in order.

### Server behavior

- Action records are append-only.
- Server applies forward patches in total order to maintain materialized state.
- If rollbacks exist, choose the rollback targeting the oldest state and roll back once, then continue applying forward patches (skip rollback markers).
- Server accepts **late-arriving** actions (older replay key, newer `server_ingest_id`) and re-materializes via rollback+replay of patches so base tables match canonical replay order.
- Server rejects uploads when the client is behind the server ingestion head (by `server_ingest_id` for actions visible to that client); clients must fetch+reconcile+retry.

#### Historical note (Update 1)

Synchrotron originally tried a different rollback/replay strategy:

1. Rollback action recorded all rollback patches, then replayed actions were re-recorded as _new_ `action_records`.
2. The server only applied forward patches (including rollback patches).
3. `action_modified_rows` merged multiple modifications to the same row into a single record.

This caused problems (especially on the server: rollback patches could reference state that never existed server-side until after the rollback), so the design changed:

1. `RollbackAction` is a patch-less marker that references a target ancestor action id.
2. Replay does **not** create new `action_records` or patches for existing actions; it re-applies existing history in canonical order and may emit new patch-only `_InternalCorrectionApply` (CORRECTION) deltas.
3. The server handles rollbacks like the client: choose the rollback targeting the oldest state, roll back to it, then apply forward patches for actions in total order (skipping rollbacks).
4. `action_modified_rows` records every mutation to a row with an incrementing `sequence` (no merging), so forward/reverse patch application is well-defined.

## Live sync and bootstrap

- Fetch/stream remote actions by `action_records.server_ingest_id > client_sync_status.last_seen_server_ingest_id` (receipt cursor), then sort/apply by replay order key (`clock_time_ms`, `clock_counter`, `client_id`, `id`).
- Remote ingress is transport-specific (Electric stream, RPC fetch, polling, etc). Transports deliver remote sync-log rows; `sync-core` persists them into local `action_records` / `action_modified_rows` via a shared ingestion helper. Applying those remotes is DB-driven: the client applies actions discovered in the local DB (`synced=true` and not present in `local_applied_action_ids`), not by trusting the transient fetch return value.
- By default, the fetch/RPC path excludes actions authored by the requesting client (avoid echo). `includeSelf=true` is primarily a fallback for action-log restore (see below).
- `last_seen_server_ingest_id` is treated as an **applied** watermark (not merely ingested) for remote (other-client) actions: it is advanced only after those actions have been incorporated into the client’s materialized state (apply/reconcile). It is also used as `basisServerIngestId` for upload head-gating.
- `performSync()` begins with a lightweight “sync doctor” step to keep local sync metadata self-consistent:
  - deletes obvious orphan rows from sync metadata tables (e.g. `local_applied_action_ids`, `action_modified_rows`, `local_quarantined_actions`)
  - advances `last_seen_server_ingest_id` to the applied-remote watermark when it lags
  - detects cursor/applied-set corruption (a remote action that is `synced=true` but missing from `local_applied_action_ids` at or before `last_seen_server_ingest_id`) and triggers a single automatic `hardResync()` / `rebase()` + retry (subject to quarantine rules)
- Use up-to-date signals to ensure the complete set of `action_modified_rows` for a transaction has arrived before applying. The sync loop will not apply remote actions until their patches are present, to preserve rollback correctness and avoid spurious outgoing CORRECTION deltas.
- This may use Electric's experimental `multishapestream` / `transactionmultishapestream` APIs, depending on how you stream the shapes.
- Bootstrap / restore options:
  - Fast bootstrap snapshot (recommended): hydrate base tables from the server’s canonical state and reset `client_sync_status` from the snapshot metadata. The RPC transport provides this via `FetchBootstrapSnapshot` (tables + head `server_ingest_id` + `serverClock`); the client applies it with patch tracking disabled, sets `last_seen_server_ingest_id` to the snapshot head cursor (and uses `serverClock` as the new clock baseline), then resumes incremental action fetch from that point.
  - Action-log restore (fallback): if snapshot bootstrapping isn’t configured, fetch actions with `includeSelf=true` starting at `sinceServerIngestId=0`, then apply from the local action tables to rebuild materialized state (O(history)).
  - Recovery primitives:
    - Hard resync: discard local base state + sync log and re-apply a bootstrap snapshot (escape hatch for corrupted/unknown local state).
    - Rebase (soft resync): discard local base state + _synced_ history, apply a fresh snapshot, then re-run pending local actions (preserving `action_records.id` so `DeterministicId`-generated row ids remain stable) before attempting to sync again. This is the intended recovery path for future server-side action-log compaction/retention windows.
  - History discontinuity detection (epoch + retention watermark):
    - `sync_server_meta.server_epoch` is a server-generated UUID “generation token” returned with sync RPC responses. Clients persist it in `client_sync_status.server_epoch`. If it ever changes, the client treats the server history as discontinuous (restore/reset/breaking migration) and must `hardResync()` (no pending actions) or `rebase()` (pending actions).
    - `minRetainedServerIngestId` is returned with sync RPC responses and represents the earliest `action_records.server_ingest_id` still retained on the server. If `client_sync_status.last_seen_server_ingest_id + 1 < minRetainedServerIngestId`, the server cannot serve an incremental delta; clients must `hardResync()` / `rebase()`.
    - Clients attempt discontinuity recovery at most once per `performSync()`; persistent discontinuity requires app/user intervention.

## Security and privacy

- Convergence is defined per-user view (as determined by RLS): for a given user, the user’s visible state converges (different users can legitimately see different overall DB contents).
- PostgreSQL RLS must protect both application tables and the sync tables (`action_records`, `action_modified_rows`) on reads and writes.
- `action_records.user_id` records the **originating authenticated principal** (who executed the action) and is used for audit + “apply under the right identity” (RLS `WITH CHECK`).
  - For per-user / owner-only apps, sync-table visibility can be filtered by `action_records.user_id`.
  - For shared/collaborative rows, sync-table visibility should be derived from `action_modified_rows.audience_key` (membership/sharing rules) rather than only the originating user (see `docs/shared-rows.md`).
  - In both cases, the server must derive `user_id` from auth and set `synchrotron.user_id` (and `request.jwt.claim.sub` for Supabase `auth.uid()` compatibility) for each request/transaction before reading/writing/applying patches.
  - Server patch application runs under the **action’s** principal (derived from `action_records.user_id`), not the request principal. This is required for correct server-side replay under base-table RLS.
- The server must be able to read the full sync log during rollback+replay even when the current request user can’t see it (e.g. after membership revocation). The recommended pattern is a sync-table RLS escape hatch keyed off `synchrotron.internal_materializer=true` (set only for server internal materialization, ideally also gated by DB role).
- If base-table RLS depends on membership/ACL tables, those tables must be replayable as part of canonical history (avoid out-of-band membership churn if you want late-arrival correctness).
- The RPC server derives the per-request RLS identity (`user_id`) from verified auth:
  - `Authorization: Bearer <jwt>` (`sub` → `user_id`, optional `aud`/`iss` checks; HS256 demo verifier or JWKS/RS256).
- Synchrotron does not generate RLS policies; the application must define them for its own data tables.
- Trust model: clients are assumed honest; the server never runs action logic and largely relies on Postgres constraints + RLS for safety.
- Because server rollback+replay happens inside a single SQL transaction, patch application can temporarily violate foreign-key ordering even when the final state is valid. If you use FKs between synced tables, prefer `DEFERRABLE` constraints (ideally `DEFERRABLE INITIALLY DEFERRED`); the server defers constraints during materialization so commit-time enforcement still applies.
- Clients must not receive patches that touch rows they cannot see; this implies `action_modified_rows` must be filtered by policies that track underlying row visibility (see `docs/security.md` and `docs/shared-rows.md`).
- Args visibility is part of the contract: if a user can read an `action_records` row, they can read its `args` (no field-level redaction). Applications should avoid putting secrets in `args`; store private inputs in RLS-protected tables and pass only opaque references.
- Patch verification (for reverse patches) can be enforced server-side with a SECURITY INVOKER function: check that every referenced row is visible under the caller's RLS policy; missing rows imply unauthorized modifications.

Private-data divergence example:

- Client B modifies shared rows and private rows in one action.
- Client A can only see shared rows, so it only receives patches for shared rows.
- A replica with access to the private rows can emit an (additive) CORRECTION action containing additional patches for those private rows.
- On rollback, Client B rolls back and replays with its full state, restoring shared + private rows.

Note: if hidden/private state influences writes to shared rows, CORRECTION can become visible and may leak derived information via shared state; this is application-dependent and should be treated as a design constraint.

If hidden/private state influences writes to shared rows, different user views can legitimately compute different values for the same shared `(table,row,column)`. When that happens, CORRECTION deltas can include visible overwrites and the system effectively becomes **last-writer-wins for that shared field** (the last CORRECTION in canonical HLC order wins). This should be treated as an application-level constraint and surfaced with loud diagnostics; repeated flips without any new non-CORRECTION inputs suggests action impurity (nondeterminism) or clock/time-travel bugs.

Avoiding unintended writes:

- Replay runs your action code. If actions are not scoped, "mark all complete" can touch other users' rows.
- Always include user/tenant filters (or pass user context explicitly as args).

## Patch semantics

`action_modified_rows` records operations plus per-column value maps.

- `operation` is one of `INSERT`, `UPDATE`, `DELETE`.
- `forward_patches` is what to apply:
  - INSERT: full row JSON
  - UPDATE: changed fields only (including explicit `null` for removed fields)
  - DELETE: empty
- `reverse_patches` is what to undo with:
  - INSERT: empty (undo is DELETE)
  - UPDATE: previous values for changed fields
  - DELETE: full row JSON (undo is INSERT)

Within one action transaction, multiple operations against the same row are recorded separately with increasing `sequence`. Rolling back to the transaction start means applying reverse operations in reverse `sequence` order.

Complex types are stored as JSON. Relationships are represented by normal primary/foreign key values.

## Storage management

- The action/patch log grows over time; long-term pruning needs a "rebase" strategy.
- Think of this like a Git rebase: periodically take a snapshot/new base, then replay any remaining local actions on top.
- A simple policy is to drop action records older than a window (e.g. one week) and force late clients to rebase from a snapshot/current state.
- The server can implement retention/compaction as deletion of old `action_records`/`action_modified_rows` rows (time-based by trusted `action_records.server_ingested_at`). The client detects this via `minRetainedServerIngestId` and automatically hard-resyncs/rebases.
- Deletes are often easiest as soft-deletes plus later garbage collection, because other clients may still replay actions that reference a row.

## Error handling

- Action execution is transactional: any failure rolls back the transaction (including the action record).
- Sync should retry on transient conflicts (e.g. exponential backoff, replay-on-reject).
- Server history discontinuities:
  - `SyncHistoryEpochMismatch` and `FetchRemoteActionsCompacted` trigger a single automatic `hardResync()` (no pending actions) or `rebase()` (pending actions), then retry `performSync()` once.
  - If a client already has quarantined local actions, discontinuity recovery requires app/user intervention (discard quarantined work or hard resync), to avoid silently losing blocked local work.
- Upload rejection policy:
  - `SendLocalActionsBehindHead` is treated as transient and retried (fetch → reconcile → resend).
  - Sync-metadata corruption triggers a single automatic `hardResync()` / `rebase()` + retry, using the same “no quarantined local actions” rule as discontinuity recovery.
  - `SendLocalActionsInvalid` triggers a single automatic `rebase()` + retry. If it still fails, the client quarantines all local unsynced actions.
  - `SendLocalActionsDenied` quarantines all local unsynced actions immediately (rebase will not fix authorization).
  - While quarantined (`local_quarantined_actions` non-empty), uploads are suspended but remote ingestion continues; the app must resolve by either discarding local unsynced work (rollback + drop) or running a hard resync.

## Testing

Setup:

- Multiple in-memory PGlite instances to simulate clients and server
- Effect layers to provide separate services per client
- A mock network service for synchronization during tests
- Effect `TestClock` to control time and create concurrency
- Note: `@effect/sql` transactions are fiber-local via a shared `SqlClient.TransactionConnection`. When tests use multiple `SqlClient`s (e.g. SQLite clients + a PGlite server), avoid running server statements inside client transactions and explicitly provide the client `SqlClient` to patch-apply effects.

Important test cases:

- Patch triggers:
  - reverse operations restore DB state at transaction start under any operation order
  - deterministic IDs match across replays
- HLC:
  - ordering and merge semantics
  - causality detection and tie-breaking
- Sync protocol:
  - fast-forward with/without CORRECTION emission
  - applying CORRECTION actions as patches (no action code)
  - rollback to common ancestor and replay in total order
  - server rollback selection and patch application ordering
- Security:
  - RLS prevents seeing private data rows
  - RLS prevents seeing patches to private rows
  - server-side patch verification rejects unauthorized reverse patches

## Future work

- ESLint rule/plugin to detect impure action functions
- Purity testing by replay (apply twice with savepoint, compare patches)
- Helper functions for standardizing user context in actions
- Schema migration handling for action definitions
- Versioning strategy for the overall system
- Clock drift detection with configurable maximum allowable drift
- Optional manual conflict resolution hooks
- Vector clock pruning for inactive clients

Performance ideas:

- Patch size reduction (compression, batching)
- Sync efficiency (incremental sync, connection-aware strategies)
- Storage optimization (garbage collection, indexing, compression)
