# Synchrotron Consistency Audit: Ordering, Rollbacks, SYNC Semantics

This doc captures design/implementation mismatches found while reviewing `README.md`, `DESIGN.md`, and the current sync-core/server code. It’s organized into separable workstreams so we can tackle issues independently.

## 0) Summary / Workstreams

1. **Canonical ordering**: align TypeScript action ordering, SQL `compare_hlc`, and persisted ordering columns (`clock_time_ms`, `clock_counter`) as a single source of truth.
2. **Rollback semantics**: clarify whether rollback actions must be interpreted by *all* clients (and if so, implement client-side handling).
3. **`rollback_to_action` safety**: ensure rollback can’t “undo” actions that were never applied locally.
4. **SYNC patch apply correctness**: ensure `_InternalSyncApply` is applied without triggers, and that INSERT patches are supported.
5. **Clock drift + concurrency model**: validate whether the current HLC/concurrency implementation matches the intended algorithm.
6. **Patch/apply generality**: remove schema-specific assumptions (e.g. special-casing `tags`) and define a portable patch-value encoding.
7. **Testing gaps**: fix test harness issues that may be hiding multi-client bugs.

---

## 1) Canonical Ordering Is Not Single-Source-of-Truth

### What we want (per docs)

- A stable global ordering for replay (“total order”) across:
  - client apply/replay order
  - server apply order
  - DB query ordering (`ORDER BY`)
  - common-ancestor and rollback selection

### What exists today (three different notions)

1. **TypeScript ordering**: `HLC._order` / `orderLogical` (`packages/sync-core/src/HLC.ts:61`).
2. **SQL comparison**: `compare_hlc(hlc1, hlc2)` (`packages/sync-core/src/db/sql/clock/compare_hlc.ts:1`).
   - Notably returns `2` for concurrency, i.e. not a total order.
3. **Persisted ordering key**: `(clock_time_ms, clock_counter, client_id, id)` derived from `(clock.timestamp, clock.vector[client_id])` (`packages/sync-core/src/db/sql/schema/create_sync_tables.ts`).
   - Index-friendly (btree) and deterministic across TS + SQL.

### Concrete mismatch example (realistic)

Same physical timestamp, divergent vectors:

- A: `{ timestamp: 1000, vector: { a: 2, b: 1 } }`
- B: `{ timestamp: 1000, vector: { a: 1, b: 2 } }`

Behavior:

- SQL `compare_hlc(A,B)` ⇒ `2` (“concurrent”) (`packages/sync-core/src/db/sql/clock/compare_hlc.ts:1`).
- TS `HLC._order(A,B)` ⇒ returns `-1|1` (forces an order via `orderLogical`) (`packages/sync-core/src/HLC.ts:61`).
- Historical note: the old `sortable_clock` heuristic could disagree with TS ordering; this is now removed in favor of the composite ordering key.

### Why this matters

- Any code that treats “comparison” as a strict ordering can become inconsistent across layers.
- Rollback selection and “common ancestor” selection depend on ordering; if those are inconsistent, convergence becomes brittle.
- SQL code that does `compare_hlc(...) > 0` treats concurrency (`2`) as “newer” (since `2 > 0`), which may or may not be intended (but must be explicit).

### Workstream tasks

- **Define a canonical ordering spec** for action records:
  - If we want a true total order, define a deterministic tie-break for concurrency (e.g. client id, action id).
  - If we want a partial order + “concurrent” result, avoid using it in places that require total ordering.
- **Choose the canonical artifact**:
  - Persist the composite ordering key `(clock_time_ms, clock_counter, client_id, id)` and use it everywhere for total ordering.
- **Align SQL + TS**:
  - `compare_hlc` should either implement the total order (including tie-break) or be renamed/used only as a partial order (“happens-before / concurrent”).
  - Queries using `compare_hlc > 0` should be audited.

### Tests to add

- Golden tests for a suite of actions where:
  - TS comparator and DB ordering by `(clock_time_ms, clock_counter, client_id, id)` agree for total order.
- Property test idea: generate random vectors for same timestamp and verify stable ordering (with deterministic tie-break) is consistent across TS and SQL.

---

## 2) Rollback Semantics & Propagation (Soundness Unclear)

### Intended model (docs)

`DESIGN.md` describes rollback as a system action representing rollback to a common ancestor plus replay in total order, with optional SYNC diffing for private-data divergences.

### Current implementation signals

- The “rollback action” tag is `RollbackAction` (`packages/sync-core/src/ActionRegistry.ts:102`).
- Client apply loop special-cases `_Rollback` (underscore) and skips it (`packages/sync-core/src/SyncService.ts:392`), but no code path actually creates `_Rollback`.
- `RollbackAction` is a no-op by design (just a record) (`packages/sync-core/src/ActionRegistry.ts:102`).

### Observed behavior on clients today

When a client receives an action record whose `_tag` is `RollbackAction`:

- It is treated like a normal action:
  - action creator exists (`rollbackAction`), so it executes (no-op) and is marked locally applied.
- There is **no** explicit call to `rollback_to_action(...)` tied to receiving a rollback record.

### Why this might be OK (hypothesis)

It could be sound if:

1. Every rollback is “fully materialized” into subsequent non-rollback actions/patches such that any client that just applies the resulting actions/patches ends up in the correct state, and
2. The SYNC mechanism is sufficient to correct private-data divergences without needing other clients to “interpret” the rollback action.

### Why this might *not* be OK (open risks)

- The rollback record itself may be needed as a coordination signal to rebase the applied/unapplied sets (e.g., `local_applied_action_ids`) and ensure subsequent replay is from the right ancestor.
- If any client state depends on whether historical actions are considered “applied” (not just the DB rows), ignoring rollback semantics can desynchronize internal metadata even if user tables converge.
- The `_Rollback` vs `RollbackAction` mismatch is at least a correctness hazard (dead branch / wrong tag).

### Workstream tasks

- **Clarify the protocol contract**:
  - Are rollback records informational only, or must all nodes interpret them?
  - What invariants should hold for `local_applied_action_ids` after receiving a rollback?
- **Fix the tag mismatch / dead code**:
  - Decide whether `_Rollback` is a legacy tag or if clients should be skipping `RollbackAction` instead.
- **Design a client behavior** (if rollbacks must be interpreted):
  - On receiving a rollback record, call `rollback_to_action(target_action_id)` and then apply remaining actions in canonical order.

### Tests to add

- 3-client scenario:
  - Client A + B diverge, B reconciles and emits rollback + new actions.
  - Client C receives rollback+actions without having diverged.
  - Verify both (a) user tables converge and (b) internal metadata like `local_applied_action_ids` is consistent.

---

## 3) `rollback_to_action` Applies Reverse Patches For Unapplied Actions

### Current SQL behavior

`rollback_to_action` builds `actions_to_rollback` as **all** `action_records` with a replay-order key greater than the target `(clock_time_ms, clock_counter, client_id, id)` and then reverses **all** AMRs for those actions:

- `actions_to_rollback` does not filter to locally-applied actions (`packages/sync-core/src/db/sql/action/rollback_to_action.ts:32`).
- Only the *cleanup* step (`action_ids_to_unapply`) is filtered to `local_applied_action_ids` (`packages/sync-core/src/db/sql/action/rollback_to_action.ts:40`).

### Why this is risky on clients

Clients can have action records present but not yet applied locally (e.g. Electric inserts into `action_records` before `performSync` applies them). Reversing an UPDATE that was never applied can still mutate existing rows:

- reverse of UPDATE executes an UPDATE statement unconditionally (`packages/sync-core/src/db/sql/amr/apply_reverse_amr.ts`).

So “reverse patches for unapplied actions” can be non-no-op and corrupt local state.

### Why it might exist

On the **server**, the DB state is advanced by patches for all received actions, so reversing “all actions after target” is sensible. On the **client**, the applied subset matters.

### Workstream tasks

- Split rollback behavior by role:
  - Server rollback can remain “all actions after target”.
  - Client rollback should reverse only actions that are locally applied (join to `local_applied_action_ids`).
- Or parameterize rollback:
  - `rollback_to_action(p_action_id, mode := 'server'|'client')`.
- Audit call sites:
  - `packages/sync-core/src/SyncService.ts` calls `rollback_to_action(...)` without constraining to applied actions.

### Tests to add

- Ensure a client with **unapplied** remote actions can call rollback safely (no state change).
- Ensure rollback only reverses effects of actions marked in `local_applied_action_ids`.

---

## 4) `_InternalSyncApply` Patch Apply Must Disable Triggers (INSERT Patches Likely Broken)

### Current design intent (docs)

Applying SYNC actions should apply forward patches “without generating any new action records” (`DESIGN.md`, “Applying SYNC actions”).

### Current implementation on clients

When a received action has `_tag === "_InternalSyncApply"`:

- client calls `apply_forward_amr_batch(amrIds)` directly (`packages/sync-core/src/SyncService.ts:403`).
- it does **not** set `sync.disable_trigger` before applying patches.

### Why this breaks INSERT patches

`apply_forward_amr` builds an INSERT that explicitly includes the row id (`packages/sync-core/src/db/sql/amr/apply_forward_amr.ts:49`), but the deterministic-id trigger forbids manual IDs unless triggers are disabled (`packages/sync-core/src/db/sql/pglite/archive/deterministic_id_trigger.sql:31`).

So on clients:

- applying an INSERT patch via `_InternalSyncApply` is expected to throw, unless some other session state disables triggers.

### Server behavior differs

Server code explicitly disables triggers around `apply_forward_amr_batch` (`packages/sync-server/src/SyncServerService.ts:201`), which matches the “no patch capture + allow explicit ids” requirement.

### Workstream tasks

- Wrap client-side SYNC patch apply with:
  - `set_config('sync.disable_trigger','true',true)` before `apply_forward_amr_batch`
  - reset it to `false` afterwards (mirroring server)
- Make patch apply idempotent as needed:
  - INSERT should likely be `ON CONFLICT (id) DO NOTHING` (or a defined merge) depending on semantics.

### Tests to add

- Divergence scenario that produces a SYNC action containing an INSERT patch (not just UPDATE), then ensure other clients can apply it.

---

## 5) Clock Drift / Concurrency Model Needs Reconciliation With Intended HLC

### Current behavior in TS

`HLC.isConcurrent` returns `false` if timestamps differ (`packages/sync-core/src/HLC.ts:194`), which makes concurrency detection highly sensitive to wall-clock skew.

There’s also commented-out drift window logic (`packages/sync-core/src/HLC.ts:8`).

### Why this matters

- If concurrency detection is used to decide whether reconciliation is required, skewed clocks can cause under-detection (treating concurrent actions as ordered by timestamp).
- If we rely on total ordering anyway, we should explicitly define a tie-breaker rather than implicitly trusting time.

### Workstream tasks

- Decide:
  - Is this “timestamp-dominant” approach intentional?
  - If not, implement a more standard HLC merge/order (and define drift behavior).
- Ensure SQL and TS semantics match once decided (ties into Workstream 1).

---

## 6) Patch/Apply Is Not Schema-Generic Yet

### Observed implementation constraints

- Patch apply functions special-case a `tags` array column (`packages/sync-core/src/db/sql/amr/apply_forward_amr.ts:62`, `apply_reverse_amr.ts`).
- This will likely break for:
  - other array columns
  - non-trivial types requiring special encoding/decoding (JSON, timestamps, nested objects, etc.)

### Workstream tasks

- Define a general “patch value encoding” spec (what types can appear in patches, and how they map back to SQL literals).
- Remove schema-specific column logic (or make it adapter-driven, as described in `docs/planning/db-adapter-abstraction.md`).

---

## 7) Testing Gaps That May Hide Multi-Client Bugs

### Schema isolation in tests appears incomplete

`createSchemaIsolatedClient` claims to set a client-specific schema but does not set `search_path` or otherwise rewrite table references (`packages/sync-core/test/helpers/TestLayers.ts:255`).

This risks tests unintentionally sharing the same tables between “clients”, reducing confidence in multi-client correctness.

### Workstream tasks

- Fix schema isolation in tests (true schema switching or per-client table names).
- Add tests that fail without isolation (to guard against regressions).
