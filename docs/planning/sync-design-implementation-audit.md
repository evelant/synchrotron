# 0006 — Sync Design & Implementation Audit (Convergence + Private/Conditional Actions)

## Status

Updated (audit; many items implemented)

## TL;DR

Synchrotron’s core approach (deterministic action log + rollback/replay + DB-level patch capture) is coherent and the repo has strong tests demonstrating the “SYNC delta” idea.

Since this audit was first written, the system has been updated to:

- use a receipt cursor (`server_ingest_id`) for fetch/streaming and support late-arriving actions by HLC
- keep uploads **HEAD-gated** via `basisServerIngestId` (client must fetch+reconcile+retry before upload is accepted)
- treat the server as an **authoritative patch materializer** that rewinds + replays stored patches to keep base tables aligned with canonical replay order (including late arrivals)
- treat `RollbackAction` as a patch-less replay hint (handled at the sync strategy / materializer level)
- merge observed remote clocks into the client clock during apply (no upload-time rewriting of unsent action clocks)

Remaining high-leverage gaps are mostly around: (1) formalizing SYNC stabilization/purity diagnostics for “private influences shared writes”, (2) unifying the Electric vs RPC ingress/apply story to avoid double-apply pressure, (3) crash-consistency (reconcile is not a single atomic transaction), and (4) broadening patch-apply type coverage beyond the current “mostly works for demo tables” state.

## What I reviewed

- `README.md`, `DESIGN.md`
- `docs/planning/todo/0002-reliable-fetch-cursor.md` (implemented)
- `docs/planning/todo/0003-sync-action-semantics.md` (implemented)
- `packages/sync-core` (SyncService/Clock/HLC/Patch capture/adapters/repos)
- `packages/sync-client` (RPC network service, Electric ingestion)
- `packages/sync-server` (RPC handlers + server-side ingest/apply)
- This audit originally proposed adding red “gap” tests; most have since been implemented and are now green

## Design audit

### 1) Does the design enable “full offline SQL + convergence”?

For shared data (same visibility on all replicas), the “rollback + replay in a deterministic total order” model should converge if:

- actions are deterministic given `(args, DB state)`,
- all writes to synced tables are action-scoped (patch capture always has context),
- IDs are deterministic (so replay doesn’t create different primary keys),
- there is a consistent global replay order (HLC order key).

Those are clearly stated in `README.md` and mostly enforced by the runtime (patch triggers abort when no capture context, deterministic IDs are available, etc.).

### 2) Private/conditional actions: does “SYNC delta” cover the hard case?

The SYNC idea is sound for the _intended_ case described in `0003`:

- A replica applies a batch of incoming actions under user/view `u`.
- If replay produces _additional_ effects that weren’t present in the received patch set (including any received SYNC patches), emit a SYNC action with only the missing delta.
- RLS filtering makes those deltas “mostly invisible” to users who can’t see the affected rows.

There is good test coverage in `packages/sync-core/test/sync-divergence*.test.ts` showing:

- divergence on replay creates a `_InternalSyncApply` action,
- receiving a SYNC action applies patches directly and can eliminate local divergence.

### 3) The big design caveat: private state influencing shared writes

This is the key “flaw”/constraint that determines whether the design meets the stated goal in the README:

- If hidden/private state can influence writes to rows that are visible to multiple users, then different user views can legitimately compute different replay outcomes for _shared_ rows.
- In that case SYNC is no longer “invisible” and you can get:
  - **information leakage** via shared rows, and/or
  - **competing SYNC overwrites** on shared fields (the system converges, but the semantics become “last SYNC wins” for that shared field).

`DESIGN.md` and `0003` already call this out; the project probably needs to treat it as a first-class constraint:

- Treat it as “unsupported/discouraged unless you accept leakage + churn” at the application level.
- Treat shared-field overwrites as an explicit (and diagnosable) tradeoff: replicas converge to the value of the last SYNC in canonical order, but it can leak derived information and produce surprising results.
  - Detailed write-up: `docs/planning/todo/006-sync-conflict.md`.

### 4) Rollback markers need a clarified contract

Rollback semantics are now clarified and implemented:

- `RollbackAction` is a **patch-less marker** that references an ancestor action id.
- It is not “history rewrite”; it’s a hint that replicas/materializers should roll back to a safe point and replay.
- Clients do not apply RollbackAction as a patch; they interpret it at the sync-strategy level (trigger rollback+replay), then continue replay in canonical order.
- The server may use RollbackAction as a replay hint, but it also handles late-arriving actions even without RollbackAction markers.

This is an important design decision because it affects:

- how the server remains consistent when it receives late/out-of-order actions,
- whether other clients must do anything special when RollbackAction records appear in the log,
- whether rollback markers can be pruned or must be processed.

## Implementation audit (gaps + risks)

### A) HLC receive/merge is not applied on remote ingest (doc mismatch; correctness risk)

Resolved: remote clock receive/merge is applied during action application.

- `SyncService.applyActionRecords(...)` calls `ClientClockState.observeRemoteClocks(...)` after applying a remote batch.
- This ensures causal “happens-after” and guarantees outgoing SYNC clocks can be incremented after observing the remote history.
- This covers both RPC-driven sync (`performSync`) and Electric-driven apply loops (which also call `applyActionRecords`).

### B) RollbackAction handling is effectively a no-op on clients (doc mismatch)

Resolved: RollbackAction is handled at the sync-strategy level.

- `applyActionRecords(...)` still skips RollbackAction (it has no patches), but `performSync` detects rollback markers in the remote batch, rolls back to the oldest referenced ancestor, and replays.
- There is test coverage for “remote rollback marker, no local pending” behavior.

### C) Server rollback/materialization is incomplete relative to the design

`DESIGN.md` describes the server as materializing state by applying patches in HLC order and handling rollbacks so the materialized state matches clients.

Resolved: the server materializer rewinds + replays patches so base tables match canonical replay order.

- Server ingest is append-only (`action_records` / `action_modified_rows`), but materialization is not “apply on arrival”.
- When late-arriving actions arrive (older replay key, newer `server_ingest_id`), the server rolls back to a predecessor and replays the unapplied suffix in canonical order.
- The sync-core test server simulation mirrors this behavior so core tests can cover it.

Decision: the server is authoritative (base tables are the source of truth). Track the server materialization work in `docs/planning/todo/0007-server-materialization.md`.

### D) SYNC actions are “batch deltas” (needs purity-violation handling + optional identity/compaction)

The current prototype `_InternalSyncApply`:

- is created as a placeholder record for a batch apply,
- records batch basis metadata (`appliedActionIds`) and is kept/deleted based on “remaining delta after accounting for received patches”,

This is consistent with the updated `0003` direction (SYNC as “reconciliation delta for an apply batch”), but leaves open problems for “real” usage:

    - **Non-additive delta handling is not explicit**: replay can produce differing values for row/fields already present in the received patch set. That can be legitimate during stabilization (late-arriving actions + rollback/replay changing prior outcomes), or it can indicate action impurity / shared-field divergence under RLS. We need clear diagnostics (and optional dev/test purity checks) so this doesn’t silently produce confusing overwrites.

- **Identity/compaction is underspecified**: duplicates of an identical SYNC delta are not a correctness issue, but they can bloat the log. It may still be worth adding a `delta_hash` (and possibly a compact `basis_hash`) for observability and optional compaction.
- Clock ordering of outgoing SYNC after observed remote history is ensured by observing remote clocks during apply.

### E) A small correctness footgun: delete handling in `compareActionModifiedRows`

`packages/sync-core/src/ActionModifiedRowRepo.ts` exports `compareActionModifiedRows`. It aggregates per-row forward patches but does not clear column state on `DELETE`, which can make “final state” comparisons incorrect when deletes occur. Today this is mostly used for logging (the actual SYNC delta decision uses a separate “final effects” computation in `SyncService.ts`), but it’s a trap if that helper becomes relied on.

### F) Idempotency / “apply twice” safety is fragile

Some layers catch duplicate key errors as “expected during sync conflicts” (see `examples/todo-app-web-pglite/src/hooks/useSyncedActions.ts`). That’s a sign the system currently relies on “retry/duplicate apply won’t usually break” rather than explicitly skipping already-applied action IDs during apply.

Given:

- Electric ingestion, RPC ingestion, and periodic apply loops can overlap,
- last-seen ingestion cursor can lag during crashes/restarts,

This has improved:

- `performSync` filters already-applied remote actions via `local_applied_action_ids` for idempotency (e.g. cursor resets / double ingress).
- The server materializer tracks applied action ids and applies forward patches idempotently (INSERT uses `ON CONFLICT DO NOTHING`).

Remaining risk: overlapping ingress paths (Electric + RPC) can still create “who applies / who advances cursor?” ambiguity (see J).

### G) `_InternalSyncApply` deltas are not marked as locally applied (rollback correctness risk)

Resolved: when a SYNC delta is kept, it is marked as locally applied so future rollbacks include its patches.

### H) Server patch-apply SQL is not generic (type/column assumptions leak into core)

The server-side patch applier (`apply_forward_amr` / `apply_reverse_amr`) is currently not a general “apply JSON patches to arbitrary Postgres tables” implementation:

- It has an explicit special-case for `tags` as a `TEXT[]` column.
- `apply_forward_amr`’s `INSERT` path is idempotent (`ON CONFLICT DO NOTHING`) so duplicate-ingest / retry paths do not fail on PK violations.
- Other Postgres array-typed columns (and other non-trivial types) will likely fail or be mis-applied unless they happen to round-trip through implicit casts from text / JSON.

This matters because the design claims “full offline SQL” and “general Postgres” while the server is the materialization source for bootstrap and for Electric replication.

Relevant files:

- `packages/sync-core/src/db/sql/amr/apply_forward_amr.ts`
- `packages/sync-core/src/db/sql/amr/apply_reverse_amr.ts`

### I) Server conflict detection is write-set-only and keyed off `latestIncomingClock` (can miss reorder bugs)

This has been intentionally simplified for now (honest-client model):

- The server no longer tries to do per-row/vector “patch base freshness” conflict detection.
- Instead, uploads are HEAD-gated by a coarse receipt cursor (`basisServerIngestId`), forcing clients to fetch+reconcile+retry before uploading.
- Late arrivals by replay key are accepted; the server materializer rewinds + replays patches to keep base tables correct.

Future defense-in-depth: re-introduce optional per-row staleness checks (vector causality) once the end-to-end system is stable.

### J) Electric ingestion vs RPC fetch/apply isn’t a coherent package-level story yet

There are effectively two different “remote action ingress” paths today:

- RPC fetch (`packages/sync-client/src/SyncNetworkService.ts`) inserts remote actions + AMRs, then `SyncService.performSync` applies them.
- Electric streaming (`packages/sync-client/src/electric/ElectricSyncService.ts`) inserts actions + AMRs, and app code applies them by querying `findSyncedButUnapplied()` (see `examples/todo-app-web-pglite/src/hooks/useSyncedActions.ts`).

These can overlap in a real app (and do in the example, which calls `performSync()` and also runs the “apply synced-but-unapplied” loop). Without stronger idempotency + cursor handling, this creates duplicate-apply pressure and makes it unclear which component is responsible for advancing `last_seen_server_ingest_id`.

### K) Multi-tab / multi-writer local DB is currently unsafe (client_id + clock races)

The README explicitly notes the web example “does not yet handle multiple tabs”. The current building blocks also make multi-tab risky by default:

- `ClientIdentity` uses browser storage (KeyValueStore/localStorage), so multiple tabs will typically share the same `client_id`.
- `ClientClockState.incrementClock` is not serialized across concurrent writers; two tabs can race, producing duplicate `(clock_time_ms, clock_counter, client_id)` tuples (ordering then falls back to `id`, but causality semantics get weird).
- Some queries assume a single `client_sync_status` row (e.g. `ActionRecordRepo.findSyncedButUnapplied` uses `SELECT client_id FROM client_sync_status LIMIT 1`).

PGlite itself has a documented “multi-tab worker” mode, but Synchrotron would still need a single-writer strategy for `(client_id, clock)` to make multi-tab safe.

Related detail: SQLite patch capture uses `CREATE TEMP TRIGGER ...` (and a `TEMP sync_context` table), so patch capture + enforcement is per-connection. Any app that opens multiple SQLite connections to the same DB file/OPFS store can bypass patch capture on the “other” connections unless it installs the TEMP triggers for each connection.

### L) Late-arriving actions aren’t reconciled when there are no local pending actions (canonical order risk)

With `server_ingest_id` as the fetch cursor (`0002`), it’s explicitly possible to receive a newly-ingested action whose **HLC replay order key** is _older than actions already applied locally_ (late offline upload).

Resolved: the client and server both handle late-arriving actions by rewinding + replaying so patch application order matches canonical replay order.

### M) Reconcile is not a single atomic transaction (crash-consistency risk)

The docs describe reconciliation as one transaction: rollback → insert rollback marker → replay → commit. In code, rollback (`rollbackToCommonAncestor`) and replay (`applyActionRecords`) each run in their own `SqlClient.withTransaction`, and the rollback marker insert happens between them.

This is probably fine for the current test suite, but it makes crash/restart behavior harder to reason about (you can persist a “rolled back but not replayed” state mid-reconcile).

## Concrete next steps (high leverage)

Completed since this audit:

1. RollbackAction semantics clarified (patch-less replay hint) and aligned with implementation.
2. Client observes/merges remote clocks during apply; outgoing SYNC clocks are created after observing remotes.
3. Server is an authoritative materializer (rewind + replay patches for late arrivals).
4. Added core tests for rollback markers, late arrival reorder, server upload gating, and retry-after-rejection behavior.

Remaining high-leverage next steps:

1. **Formalize SYNC semantics (batch delta + purity handling)**:
   - support stabilization cases where SYNC deltas supersede previously-known effects (including prior SYNC),
   - define purity diagnostics (and an optional dev/test “replay twice” check),
   - add optional `delta_hash`/`basis_hash` for observability + optional compaction.
2. **Unify ingress/apply responsibilities** (Electric vs RPC) to avoid double-apply pressure and clarify which component advances `last_seen_server_ingest_id`.
3. **Crash-consistency**: make reconcile atomic (single transaction) or define a restart-safe recovery protocol.
4. **Patch apply coverage**: broaden server patch applier type support beyond the current demo-friendly set.

5. **Additional edge-case tests (need a bit more design work)**:
   - **SYNC duplicates / compaction:** two clients emit the _same_ SYNC delta for the same applied batch → assert idempotent apply (safe duplicates) and (optionally) compaction keyed by `(basis_hash, delta_hash)`.
     - **SYNC purity violation is loud:** craft a nondeterministic action that produces different results on two runs against the same snapshot → assert we surface a diagnostic (and optionally suppress emitting an additional overwriting SYNC delta for that apply pass).
   - **SYNC stabilization after rebase:** client B emits a SYNC delta, then client A later reconciles with local pending actions that interleave and produces a new delta that supersedes B’s SYNC; after B fetches again and replays the full history, it should reach a fixed point (no further SYNC).
     - Concrete sketch: B fast-forwards a remote batch and emits SYNC; later, A uploads older-clock local actions that force B to rollback+replay; B may produce a new (overwriting) SYNC that supersedes the earlier one; once both have applied the full history, a subsequent sync produces no new SYNC.
     - **Shared-row divergence (LWW semantics):** craft a scenario where two _different_ views compute different writes to the same shared row/field (private state influencing shared writes) → assert the system converges to the value of the last SYNC in canonical order and surfaces a loud diagnostic (signals leakage + surprising semantics).
       - Concrete sketch: an action reads a per-user/private row and writes a _shared_ column; two different user views compute different values for the same `(table,row,column)` even with the same non-SYNC history.
   - **Transactional safety on unknown actions:** receiving an action with an unknown `_tag` should fail without leaving a persisted placeholder `_InternalSyncApply` and without partial DB changes.
   - **Rollback correctness with multi-AMR actions:** rollback/replay should correctly undo+redo actions that produced multiple `action_modified_rows` for the same row (sequence-sensitive).
   - **Server patch-apply type coverage:** add tests for applying patches to non-`tags` arrays and other tricky types (e.g. `uuid[]`, `int[]`, nested `jsonb` objects) to make “generic apply” expectations explicit.
