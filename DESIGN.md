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
  - `clock`: HLC for ordering (JSONB)
  - `transaction_id`: txid of the DB transaction
- Action modified row (`action_modified_rows`): per-row patch records captured by triggers during the action transaction.
- Execute vs apply:
  - Execute: run an action and create a new action record + patches.
  - Apply: replay an existing action record without creating a new record.
- SYNC action: a system action record whose patches represent the delta between the incoming patches and what a local replay produced (typically due to private data / conditionals).
- ROLLBACK action: a system marker that tells replicas to roll back to a specific ancestor action before replaying.
- HLC details:
  - `timestamp`: physical time (ms)
  - `vector`: map of `client_id -> counter` used for causality hints
  - local mutation increments the local counter
  - receiving remote clocks merges vectors by max; entries never reset

## Data model

`action_records` (append-only):

- `id` (text UUID)
- `_tag`, `client_id`, `transaction_id`, `created_at`, `synced`
- `clock` (HLC JSONB) and `sortable_clock` (generated string for indexing / ordering)
- `args` (JSONB; includes `timestamp`)

`action_modified_rows`:

- `id`
- `action_record_id` (FK)
- `table_name`, `row_id`
- `operation`: `INSERT` | `UPDATE` | `DELETE`
- `forward_patches`, `reverse_patches` (JSONB)
- `sequence`: monotonic per action record (preserves intra-transaction order)

Client-side:

- `client_sync_status`: `current_clock`, `last_synced_clock` (+ sortable clock columns)
- `local_applied_action_ids`: action ids already applied locally

Backend state:

- The server materializes state by applying forward patches in HLC order.
- The server never needs to execute application actions, but it does apply rollbacks so that patch application order matches clients.

## Components

- Action registry: maps `_tag` -> action implementation (in the current implementation, actions are registered and replayed via an Effect service).
- Database access layer: built on `@effect/sql` models/repositories.
- Trigger system:
  - deterministic ID trigger (BEFORE INSERT)
  - patch generation triggers (AFTER INSERT/UPDATE/DELETE) that write `action_modified_rows`
- HLC service: generates/merges clocks and provides a total order (also reflected in `sortable_clock` for indexing).
- Electric SQL integration: streams `action_records` and `action_modified_rows` (using up-to-date signals so a transaction's full set of patches arrives before applying).

## Deterministic row IDs

Inserts generate deterministic primary keys via a BEFORE INSERT trigger:

- `SyncService` sets `sync.current_action_record_id` (and resets a `sync.collision_map`) at the start of each execute/apply transaction.
- The trigger hashes the row content (excluding `id`) and produces a UUIDv5 using the action record id as the namespace.
- If two identical rows are inserted in the same action, the collision map appends a counter suffix (`hash_1`, `hash_2`, …) so IDs remain unique.
- This relies on a stable string representation of row content; today it uses the `jsonb` text representation and `md5`.

Result: replaying the same action record on different clients produces the same inserted row IDs.

## Requirements for actions

- Deterministic: same args + same DB state => same writes.
- Explicit non-determinism: pass time/random/network results/user context as args; `timestamp` is injected automatically.
- No external reads during execution.
- Immutable definitions: never change an action's meaning in-place; version via `_tag` (e.g. `create_todo_v1`).
- Scoped queries: treat actions like API endpoints; always filter by user/tenant context so replay can't touch unrelated rows.

## Executing an action

1. Begin a DB transaction.
2. Insert an `action_records` row (recording `txid_current()` as `transaction_id`).
3. Set trigger context (`sync.current_action_record_id`, reset collision map).
4. Run the action function.
5. AFTER triggers append `action_modified_rows` for every insert/update/delete (with increasing `sequence`) and associate them to the action via the transaction id.
6. Commit (or roll back on error).

## Sync and convergence

### Normal sync (no conflicts)

1. `action_records` and `action_modified_rows` replicate via Electric SQL (filtered by RLS).
2. Client applies incoming actions in HLC order.
3. A placeholder SYNC action can be used to compare "expected" incoming patches with the patches produced locally during replay.
4. If the patches match, nothing new is emitted; mark incoming actions as applied and advance `last_synced_clock`.

### SYNC actions (private data / conditional logic)

Replaying an action can legitimately produce different writes when:

- branches depend on rows the client cannot see (RLS),
- logic is conditional on private state.

When patch comparison finds a mismatch, the client emits a SYNC action record containing only the patch delta needed to converge. Incoming SYNC actions are applied directly as patches (no action code to run).

### Conflict detection

A conflict exists when incoming actions are not strictly after the client's local unsynced actions. Use HLC/vector causality to detect "happened-before" vs concurrent:

- if everything incoming is after local pending actions, fast-forward
- if anything incoming is concurrent with (or before) local pending actions, reconcile

### Reconciliation (rollback + replay)

1. Identify the common ancestor (latest fully-synced action before divergence).
2. Start a transaction.
3. Roll back to the ancestor by undoing `action_modified_rows` in reverse `sequence` order.
4. Insert a single ROLLBACK marker that references the ancestor action id.
5. Replay all actions from that point to "now" in total HLC order, using the same apply+SYNC logic as the fast-forward case.
6. Send any new actions (ROLLBACK marker + SYNC deltas) to the server.
7. If rejected due to newer actions, abort and retry with the updated history.
8. Commit.

Analogy: this is a bit like Git. Find the merge base (common ancestor), rewind to it, then replay commits to produce a single history. The difference is we replay deterministic action code (not patch hunks), and the order comes from HLC.

### Common sync cases

- No local pending actions, incoming actions exist: apply; emit SYNC only if patch diff exists.
- Local pending actions, no incoming: send local actions; mark as synced when accepted.
- Incoming actions that interleave with local pending: reconcile (rollback + replay).
- Incoming rollback markers: roll back to the oldest referenced ancestor once, then apply forward patches in order.

### Server behavior

- Action records are append-only.
- Server applies forward patches in total order to maintain materialized state.
- If rollbacks exist, choose the rollback targeting the oldest state and roll back once, then continue applying forward patches (skip rollback markers).
- Server may reject writes that are older than already-applied conflicting actions; client reconciles and retries.

## Live sync and bootstrap

- Use Electric SQL to stream `action_records` and `action_modified_rows` newer than `last_synced_clock`.
- Use up-to-date signals to ensure the complete set of `action_modified_rows` for a transaction has arrived before applying.
- This may use Electric's experimental `multishapestream` / `transactionmultishapestream` APIs, depending on how you stream the shapes.
- Bootstrap without historical actions:
  1. Fetch current server clock.
  2. Sync base tables.
  3. Set `last_synced_clock` to the server clock.

## Security and privacy

- PostgreSQL RLS filters both data tables and the action/patch tables.
- Clients must not receive patches that touch private rows they cannot see.
- Patch verification (for reverse patches) can be enforced server-side with a SECURITY INVOKER function: check that every referenced row is visible under the caller's RLS policy; missing rows imply unauthorized modifications.

Private-data divergence example:

- Client B modifies shared rows and private rows in one action.
- Client A can only see shared rows; replay can produce different results.
- Client A emits a SYNC action so shared state converges.
- On rollback, Client B rolls back and replays with its full state, restoring shared + private rows.

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
- Deletes are often easiest as soft-deletes plus later garbage collection, because other clients may still replay actions that reference a row.

## Error handling

- Action execution is transactional: any failure rolls back the transaction (including the action record).
- Sync should retry on transient conflicts (e.g. exponential backoff, replay-on-reject).

## Testing

Setup:

- Multiple in-memory PGlite instances to simulate clients and server
- Effect layers to provide separate services per client
- A mock network service for synchronization during tests
- Effect `TestClock` to control time and create concurrency

Important test cases:

- Patch triggers:
  - reverse operations restore DB state at transaction start under any operation order
  - deterministic IDs match across replays
- HLC:
  - ordering and merge semantics
  - causality detection and tie-breaking
- Sync protocol:
  - fast-forward with/without SYNC emission
  - applying SYNC actions as patches (no action code)
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
