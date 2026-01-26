# 0003 — SYNC Action Semantics (Reconciliation Deltas Under RLS)

## Status

Implemented (with follow-ups possible)

## Summary

Synchrotron replays deterministic actions, but “deterministic” is relative to the database state a replica can see. Under PostgreSQL Row Level Security (RLS), two replicas can legitimately observe different rows and therefore take different branches during replay.

To converge in the presence of partial visibility, we introduce **SYNC actions**: system actions that carry **patches only** (no action logic) to reconcile outcomes when replay produces additional writes that were not present in the originating action’s patch set due to visibility differences.

As implemented today, SYNC actions are emitted as **reconciliation deltas for an apply batch** (not as “corrections” tied to a single base action). Concretely this is `_InternalSyncApply`: a placeholder is created for the batch, then either deleted (no delta) or kept with AMRs trimmed to the uncovered delta.

This document formalizes the intended SYNC semantics so they are:

- **Additive / monotonic** in the common case (private-data divergence)
- Mostly **invisible** across users (because RLS filters patch visibility)
- Compatible with rollback + replay (SYNC participates in history like any other action)
- Robust to **accidental action impurity** (diagnostics + bounded convergence); an optional dev/test purity check is tracked separately (see `docs/planning/todo/0014-dev-test-action-purity-check.md`).

## Problem Statement

When applying a remote _batch_ of actions, a replica:

- replays action code locally (for normal actions)
- records the resulting row-level patches via triggers (`action_modified_rows`)
- compares them to the patches it received for that same batch (including any received SYNC patches)

However, if the replica can see more rows than the origin (or has additional private state), replay may touch additional rows. Those rows may be invisible to other users and therefore should not “broadcast” via sync, but they still need to converge for users who are allowed to see them.

## Goals / Non-goals

### Goals

- Define convergence precisely: for a given user (RLS policy), the user’s visible state converges.
- Make SYNC emission monotonic (“add missing writes”) in the common private-data divergence case.
- Keep SYNC actions patch-only (no business logic execution).
- Keep server logic minimal; rely on Postgres + RLS for security.
- Ensure action-determinism violations don’t cause infinite SYNC ping-pong.

### Non-goals

- Prevent inference via shared state. If hidden state influences writes to shared rows, the shared rows can reveal derived information; this is application-dependent.
- Fully specify the RLS policy patterns for `action_records` / `action_modified_rows` (tracked separately in `docs/planning/todo/0004-rls-policies.md`).

## Convergence Target

Synchrotron converges **per user view**:

- For any given user (as defined by role/tenant context + RLS policies), all replicas converge to the same state _as seen by that user_.
- Different users may observe different overall database contents due to RLS (expected).

This is the practical meaning of “mostly invisible SYNC”: SYNC patches for private rows are filtered by RLS and do not appear to users who cannot see those rows.

## Definitions

For an incoming apply batch `B` (a set of action records being applied/reconciled) and a user view `u`:

- `P_base(B, u)`: the union of forward patches (`action_modified_rows`) attached to the _non-SYNC_ actions in `B` that are visible to `u` (after RLS filtering).
- `P_sync_in(B, u)`: the union of forward patches attached to the _incoming SYNC_ actions in `B` that are visible to `u`.
- `P_known(B, u) = P_base(B, u) ∪ P_sync_in(B, u)`: everything `u` currently knows should happen as a result of applying `B`.
- `P_replay(B, u)`: the patches produced locally by replaying the _non-SYNC_ actions in `B` on a replica under user `u` (patches from incoming SYNC actions are applied directly with patch tracking disabled, so they do not contribute to `P_replay`).

We treat patches at the level of `(table_name, row_id, operation, forward_patches)` with per-column semantics.

## Proposed SYNC Semantics (Batch Patch Delta)

### SYNC action shape

A SYNC action record:

- Has a reserved `_tag` (name TBD; prototype uses `_InternalSyncApply`).
- Stores a small `basis` payload in `args` describing what was applied when the delta was computed (see below).
- Has associated `action_modified_rows` that represent the **delta patches**.

Current `args` shape (implemented):

- `appliedActionIds: string[]` (or a stable hash if this list is too large)
- `timestamp: number` (currently `0` for `_InternalSyncApply`)
- Optional: `basis: { lastSeenServerIngestId?: number; observedMaxClock?: HLC; ... }` (not implemented yet)

### Emission rule

After replaying the batch `B`, compute a patch delta:

`Δ(B, u) = P_replay(B, u) − P_known(B, u)`

Where subtraction means “keep only row/field effects that are not already present in `P_known` with the same value” (i.e. missing effects and differing values).

If `Δ(B, u)` is non-empty, emit a SYNC action whose patches are exactly `Δ(B, u)`.

Intuition:

- In the common private-data divergence case, `Δ` is purely additive (it only adds missing private-row effects).
- In general reconciliation, `Δ` can include “overwrites” (differing values) when the history basis changes (e.g. late-arriving actions cause rollback+replay, changing what an earlier action produces in canonical order). These should stabilize once all replicas have applied the same history.

### Why this helps

- If two replicas have the same user view, they should compute the same `P_replay(B, u)` and therefore either emit no SYNC or emit equivalent `Δ`; duplicate SYNC records are harmless if patch-apply is idempotent.
- If a replica has more private rows visible, it can emit additional patches affecting those private rows; other users won’t see them.

## Shared-row Caveat (When SYNC is not “invisible”)

If hidden/private state influences writes to shared rows (rows visible to multiple users), then different users can compute different `P_replay(B, u)` for the same shared row.

That leads to two risks:

- **Visibility**: SYNC patches to shared rows are visible and can leak derived information.
- **Semantics**: multiple users can legitimately emit competing SYNC overwrites to the same shared fields.

Proposed stance:

- Document this as an application-level design constraint: actions should avoid using hidden/private state to determine writes to shared rows (or accept the implications).
- Accept that in this scenario the runtime effectively becomes **last-writer-wins for the shared field**: once replicas have applied the same history, they converge to the value of the last SYNC in canonical HLC order.
- Emit loud diagnostics whenever `Δ(B, u)` includes an overwrite (a replay writes a different value for a row/field already present in `P_known`) so developers can spot shared-row divergence vs legitimate stabilization.

This does not usually create “infinite ping-pong” in steady state: replicas fast-forward apply later SYNC actions without re-running earlier business actions. Repeated flips with no new non-SYNC inputs indicates an action purity bug (nondeterminism) or clock/time-travel issues.

## Ordering Requirements

SYNC actions participate in the global history and must be ordered _after the remote batch they were derived from_.

Practical requirement:

- Before emitting a SYNC action, the replica must **receive/merge** the clocks from all observed remote actions in the batch (vector max + timestamp max), then **increment** for the new SYNC action.

This ensures the SYNC action sorts after the observed remote history in replay order (it is a “new action at the end of the sync pass”).

## Deduplication (Open Design)

Multiple replicas with the same view can emit identical `Δ(B, u)`. This is not a correctness problem; it’s a log-growth / efficiency concern.

If we want bounded growth:

- compute a canonical `delta_hash` over the SYNC patches (e.g. stable ordering + stable JSON encoding),
- optionally compute a `basis_hash` over the batch identity (e.g. action ids, or `(last_seen_server_ingest_id_before, last_seen_server_ingest_id_after)`),
- use these for optional client-side suppression, server-side compaction, and better observability.

The system should not require linking a SYNC delta to a single “corrected” base action for correctness.

## Purity violations (bug case) and ping-pong prevention

For replay-based convergence to work, actions must be deterministic and pure with respect to:

- their `args` (captured nondeterminism),
- the replica database state visible under the current user/view (RLS).

Unfortunately, it’s easy for app code to accidentally violate this (examples):

- reading wall clock directly (`Date.now()`) instead of using the captured `timestamp`,
- randomness (`Math.random()`),
- reading process/environment state,
- non-deterministic SQL (e.g. `SELECT ... LIMIT 1` without `ORDER BY`),
- relying on implicit iteration order from JSON/object maps.

### Detecting the violation

When comparing `P_replay(B, u)` to `P_known(B, u)`, classify differences into:

- **Missing effects** (common case): replay writes a row/field that is absent from `P_known` (often private rows filtered by RLS) → include in `Δ`.
- **Conflicting effects** (“overwrite”): replay writes a different value for a row/field already present in `P_known`.

  Conflicting effects are not, by themselves, a purity violation. They can be:

- a valid “stabilization” effect due to late-arriving actions / rollback+replay changing the state an earlier action runs against,
  - a shared-row divergence case (different views legitimately compute different shared-field writes; semantics become last-writer-wins for that field and may leak information),
- an actual action impurity bug (nondeterminism).

To identify _impurity_, you need evidence that replay is not repeatable on the **same** basis/snapshot.

### Handling the violation (bounded convergence + loud error)

If we detect evidence of impurity (non-repeatable replay on the same snapshot, or repeated overwriting deltas with no new non-SYNC inputs):

1. **Stop emitting arbitrary corrections**: treat the existing history (`P_known`) as authoritative for that apply pass (i.e. do not emit an additional overwriting SYNC delta), and surface an explicit sync-health error/diagnostic so the app developer sees it.
2. **Surface loudly**:
   - emit an error log/event including action ids, tags, and a diff preview (known vs replay values),
   - optionally persist a local diagnostic record so apps can show a “sync is unhealthy” banner.

Optional mitigation in development/test (tracked in `docs/planning/todo/0014-dev-test-action-purity-check.md`):

- Run actions twice against the same DB snapshot (transaction + savepoint/rollback) and assert identical captured patches; this provides a strong “purity violation” signal without needing cross-client state comparisons.

## Current Implementation (Where We Are Today)

**Client**

- Placeholder `_InternalSyncApply` is created per apply batch and patch capture is scoped to it while replaying remote non-SYNC actions.
- Incoming SYNC actions are applied as patches with patch capture disabled (so they don’t recursively generate more SYNC).
- The outgoing delta is computed by comparing generated patches (from replay) to the known patch set (base + received SYNC):
  - if everything is covered, the placeholder SYNC is deleted
  - otherwise, its AMRs are trimmed to only uncovered row effects and its clock is incremented so it sorts after the batch
- Outgoing SYNC is marked locally-applied for rollback correctness.

See `packages/sync-core/src/SyncService.ts` (`applyActionRecords`).

**Existing coverage**

- Divergence creates SYNC and keeps the placeholder when needed: `packages/sync-core/test/sync/sync-divergence.test.ts`
- Incoming SYNC is applied directly (and can suppress redundant deltas): `packages/sync-core/test/sync/sync-divergence.test.ts`
- Outgoing SYNC ordering and local-applied marking: `packages/sync-core/test/sync/sync-delta-semantics.test.ts`
- Idempotent re-apply of received SYNC: `packages/sync-core/test/sync/ingest-idempotency.test.ts`

## RLS Requirements (Underspecified Today)

To avoid leaking private data through the sync tables:

- `action_modified_rows` visibility must be constrained so a user only sees patch rows for data rows it can see.
- `action_records` visibility/args must not leak sensitive data:
  - either scope `action_records` similarly,
  - or require that `args` contain no sensitive payload (only identifiers + captured nondeterminism that is safe to reveal to the users who can see the action).

This project needs a concrete, recommended pattern for RLS on the sync tables.

## Testing Plan

Covered today (SyncService unit/integration tests):

- Divergence creates an outgoing SYNC delta and associates AMRs with it: `packages/sync-core/test/sync/sync-divergence.test.ts`
- Incoming SYNC is applied as patches and can suppress redundant outgoing deltas: `packages/sync-core/test/sync/sync-divergence.test.ts`
- Outgoing SYNC sorts after the corrected batch (observe remotes, then increment): `packages/sync-core/test/sync/sync-delta-semantics.test.ts`
  - Idempotency: re-applying the same received SYNC does not create another outgoing SYNC: `packages/sync-core/test/sync/ingest-idempotency.test.ts`

Also covered (Postgres/RLS e2e):

- Private divergence under real RLS: a replica with strictly more visibility emits an additive SYNC delta that is filtered from other users: `packages/sync-server/test/e2e-postgres/sync-rpc.e2e.test.ts`.

Optional / next:

- Optional (dev/test): action purity check (replay twice) is tracked separately in `docs/planning/todo/0014-dev-test-action-purity-check.md`.

## Open Questions

- What is the minimal `basis` metadata we should store in `args` (full list vs hashes)?
- Optional (dev/test): if we implement the purity check (TODO `0014`), should a purity violation be diagnostics-only, or should it abort sync / suppress overwriting deltas?
- What is the minimal schema/support we want for observability (e.g. `delta_hash`, diagnostics table)?
- What RLS policy pattern do we recommend for `action_modified_rows` given `(table_name, row_id)`?
