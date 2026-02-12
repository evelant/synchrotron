# Synchrotron design

Synchrotron is an offline-first sync system for Postgres that converges by replaying deterministic business-logic actions.

Instead of treating row/field patches as the source of truth (e.g. last-write-wins replication), Synchrotron replicates an **operation log**: actions + their arguments + an ordering clock. When histories diverge, clients roll back to a common ancestor and replay actions in total order.

Row-level patches still exist, but they are a low-level mechanism used to:

- make rollback/fast-forward cheap,
- detect when replay produced a different outcome, and
- repair divergence deterministically.

If you’re looking for “how do I integrate this into an app?”, start with `docs/usage.md` and `docs/transports.md`.

## Contents

- Goals / non-goals
- Core data model
- Executing local actions
- Ingress, ingestion, and apply (DB-driven correctness)
- CORRECTION deltas (private-data divergence)
- Divergence + reconciliation (rollback + replay)
- Server materialization
- Bootstrap + retention + recovery
- Security + shared rows
- Limitations and design constraints

## Goals / non-goals

Goals:

- Offline-first writes against a local SQL database.
- Intention preservation through business-logic replay.
- Deterministic total ordering via HLC-based ordering.
- Minimal server logic: the server does not run application action code.
- Security via Postgres RLS (per-user view convergence, including private data divergence).
- Transport pluggability for remote ingress (polling, push, hybrids).

Non-goals:

- Defending against malicious clients (assume honest clients; enforce access control with RLS).
- Hiding secrets in action args (args are replicated to any replica that can read the action record).
- High write contention across many concurrent writers to the same audience (not the intended envelope).

## Core data model

### `action_records` (append-only action log)

Each action execution creates one immutable row:

- `id` (UUID as text)
- `server_ingest_id` (BIGINT; server-assigned monotonic cursor for incremental fetch/stream)
- `_tag` (action identifier; treat as versioned API, e.g. `create_todo_v1`)
- `args` (JSON; includes captured nondeterminism like `timestamp`)
- `client_id` (origin device)
- `user_id` (origin principal; used for audit + server-side “apply under the action principal”)
- `transaction_id` (app-provided number; for app-level correlation/debug)
- `clock` (HLC JSON) plus derived ordering columns: `clock_time_ms`, `clock_counter`
- `created_at`, `server_ingested_at`, `synced`

Portability notes:

- Postgres/PGlite store JSON as JSONB; SQLite often stores JSON as strings. Synchrotron encodes/decodes accordingly.
- Some drivers return `BIGINT/INT8` as strings; Synchrotron decodes these into numbers in TypeScript.

### `action_modified_rows` (row-level patch log)

Patch capture records the row effects of each action transaction:

- `action_record_id` (FK to `action_records`)
- `table_name`, `row_id`
- `operation`: `INSERT` | `UPDATE` | `DELETE`
- `forward_patches`, `reverse_patches` (JSON)
- `sequence` (monotonic per action record; preserves intra-transaction order)
- `audience_key` (application-defined visibility token; indexed and used for RLS filtering)

### Client sync metadata

Clients persist sync state in local tables:

- `client_sync_status`:
  - `current_clock`, `last_synced_clock`
  - `last_seen_server_ingest_id` (remote applied watermark; see below)
  - `server_epoch` (history generation token for discontinuity detection)
- `local_applied_action_ids`: which remote `action_records.id` are already applied locally
- `local_quarantined_actions`: unsendable local work (upload gate)

## Executing local actions

Local writes only happen inside actions executed by `SyncService.executeAction`.

At a high level:

1. Begin a DB transaction.
2. Insert an `action_records` row.
3. Run the action function (with deterministic ID generation scoped to the action id).
4. AFTER triggers append `action_modified_rows` for every insert/update/delete (in `sequence` order).
5. Commit (or roll back on error).

Determinism contract:

- Action code must be deterministic given the same DB snapshot and args.
- Any nondeterministic inputs (time, randomness, network results, ambient state) must be captured in args.
- `timestamp` is part of the args schema and is injected automatically when creating the action, then preserved for replay.

## Ingress, ingestion, and apply (DB-driven correctness)

Synchrotron is intentionally **DB-driven**:

- Transports deliver remote history rows (actions + patches) and/or wakeups.
- `sync-core` ingests those rows into the local sync tables.
- Apply/reconcile reads from the local DB, not from transient network responses.

This yields:

- idempotence (duplicates are OK),
- a single “ingress queue” for both polling and push transports,
- and consistent apply semantics even if ingress arrives out-of-order.

### Ingress sources

Remote history can arrive via:

- pull (RPC polling),
- push (Electric, SSE/WS with payload),
- notify + pull (server pings, client pulls deltas),
- hybrids (push most of the time; pull for repair/backfill).

`SyncIngress` is an optional service that exposes ingress events:

- `Batch`: delivers `{ actions, modifiedRows }` payloads
- `Wakeup`: notify-only signal to attempt a sync run

The core-owned ingress runner:

1. ingests `Batch` rows into local tables (idempotent), then
2. triggers `SyncService.requestSync()` (single-flight + coalescing).

See `docs/transports.md` for the full boundary.

### Fetch cursor vs replay order

Two orderings matter:

- **Fetch/stream ordering** uses `server_ingest_id` (monotonic cursor) so clients can incrementally receive all actions visible to them.
- **Replay ordering** uses the HLC-derived key (`clock_time_ms`, `clock_counter`, plus stable tie-breakers) so replicas replay in the same total order.

### Applied watermark (`last_seen_server_ingest_id`)

Clients treat `client_sync_status.last_seen_server_ingest_id` as an **applied** watermark for remote actions.

It advances only after the corresponding remote actions have been incorporated into the client’s materialized state (apply/reconcile). It is also used as `basisServerIngestId` for head-gated uploads.

## Patch semantics

`action_modified_rows` records operations plus per-column maps:

- `operation` is one of `INSERT`, `UPDATE`, `DELETE`.
- `forward_patches` describes what to apply:
  - `INSERT`: full row JSON
  - `UPDATE`: changed fields only (including explicit `null` for removed fields)
  - `DELETE`: empty
- `reverse_patches` describes what to undo with:
  - `INSERT`: empty (undo is `DELETE`)
  - `UPDATE`: previous values for changed fields
  - `DELETE`: full row JSON (undo is `INSERT`)

Within one action transaction, multiple operations against the same row are recorded separately with increasing `sequence`. Rolling back to the transaction start means applying reverse operations in reverse `sequence` order.

## CORRECTION deltas (private-data divergence)

Replaying an action can legitimately produce different writes when:

- branches depend on rows the client cannot see (RLS),
- logic is conditional on private state.

Synchrotron repairs this with **CORRECTION** actions: patch-only action records whose patches represent the delta between:

- patches the replica knows for a batch (`P_known`), and
- patches produced by deterministic local replay (`P_replay`).

Key properties:

- Incoming CORRECTION actions apply directly as patches (no action code to run).
- In the common case (private-data divergence), CORRECTION is additive: it fills in missing effects the replica couldn’t see during initial ingestion.
- Deltas are normalized to keep apply/rollback semantics well-defined:
  - if replay produces an `INSERT` for a row that already exists in `P_known`, the outgoing CORRECTION uses an `UPDATE` (and aligns `reverse_patches`).
- Guardrail for “subtractive” divergence:
  - if a row key exists in the received **base** patch set but replay produces no patches for that row key, Synchrotron treats `P_known` as authoritative for that row key and patch-applies the known patch sequence with patch tracking disabled (so base tables still converge, without emitting an outgoing CORRECTION).

Correctness requirement:

- replicas reach a fixed point once they have applied the same history.
- repeated non-convergence for the same basis indicates action impurity (nondeterminism) or an unsupported shared-row divergence pattern.

## Divergence + reconciliation (rollback + replay)

### When reconciliation is needed

A conflict exists when incoming actions are not strictly after the client’s local unsynced actions (i.e. the histories interleave). Synchrotron detects this via clock/vector ordering and falls back to reconciliation.

### Reconciliation algorithm (client)

1. Identify the common ancestor (latest fully-synced action before divergence).
2. Start a transaction.
3. Roll back to the ancestor by undoing `action_modified_rows` in reverse `sequence` order with patch tracking disabled.
4. Insert a single rollback marker referencing the ancestor action id.
5. Replay all actions from that point to “now” in total replay order, using the same apply + CORRECTION logic as fast-forward.
6. Upload any newly-created actions (rollback marker + CORRECTION deltas).
7. If rejected due to newer actions, abort and retry with the updated history.
8. Commit.

Analogy: like Git. Find a merge base, rewind, then replay commits. The difference is Synchrotron replays deterministic action code (not patch hunks), and the order comes from HLC.

## Server materialization

The server maintains canonical base tables by applying patches in canonical order. It does not run application action code.

Important behaviors:

- Action records are append-only.
- The server accepts late-arriving actions (older replay key, newer `server_ingest_id`) and re-materializes via rollback+replay of patches so base tables match canonical replay order.
- Uploads are head-gated:
  - clients include `basisServerIngestId`,
  - the server rejects uploads when the client is behind the server ingestion head for the actions visible to that client.

## Bootstrap + retention + recovery

Synchrotron is designed to avoid “stuck clients” by providing explicit recovery primitives:

- `hardResync()`: discard local state and apply a fresh bootstrap snapshot.
- `rebase()`: keep pending local actions, apply a fresh snapshot, then re-run the pending actions (preserving action ids for deterministic ID stability).

Bootstrap snapshots: `docs/bootstrap.md`  
Server retention/compaction + recovery: `docs/server-retention-compaction.md`

## Security + shared rows

Synchrotron relies on Postgres RLS for access control:

- clients only receive rows/patches they are allowed to see,
- convergence is defined per-user view (different users can legitimately see different overall DB contents).

Shared/collaborative data is modeled with an application-defined `audience_key`:

- base tables and sync log rows are filtered via membership on `audience_key`,
- `audience_key` is treated as canonical and stable (moves are modeled as delete+insert).

Docs:

- Security model (RLS + auth): `docs/security.md`
- Shared rows: `docs/shared-rows.md`

## Limitations and design constraints

- **High write contention**: if many clients constantly write to the same audience, head-gated uploads can thrash; Synchrotron is not optimized for that regime.
- **Shared-row determinism constraints**: if hidden/private state influences writes to shared rows, CORRECTION can become visible and may leak derived information via shared state. Treat this as an application design constraint.
- **Args are replicated**: anyone who can read an `action_records` row can read its `args` (no redaction). Keep args non-sensitive; store secrets in RLS-protected tables and pass opaque references.
- **Effect-centric**: Synchrotron is deeply tied to Effect’s model of services/layers and structured concurrency.

