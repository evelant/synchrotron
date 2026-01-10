# 0003 — SYNC Action Semantics (Replay Corrections Under RLS)

## Status

Proposed

## Summary

Synchrotron replays deterministic actions, but “deterministic” is relative to the database state a replica can see. Under PostgreSQL Row Level Security (RLS), two replicas can legitimately observe different rows and therefore take different branches during replay.

To converge in the presence of partial visibility, we introduce **SYNC actions**: system actions that carry **patches only** (no action logic) to reconcile outcomes when replay produces additional writes that were not present in the originating action’s patch set due to visibility differences.

This document formalizes the intended SYNC semantics so they are:

- **Additive / monotonic** in the common case (private-data divergence)
- Mostly **invisible** across users (because RLS filters patch visibility)
- Compatible with rollback + replay (SYNC participates in history like any other action)

## Problem Statement

When applying a remote action `A`, a replica:

- replays `A`’s action code locally
- records the resulting row-level patches via triggers (`action_modified_rows`)
- compares them to the patches associated with `A` that it received from the origin

However, if the replica can see more rows than the origin (or has additional private state), replay may touch additional rows. Those rows may be invisible to other users and therefore should not “broadcast” via sync, but they still need to converge for users who are allowed to see them.

## Goals / Non-goals

### Goals

- Define convergence precisely: for a given user (RLS policy), the user’s visible state converges.
- Make SYNC emission monotonic (“add missing writes”) in the common private-data divergence case.
- Keep SYNC actions patch-only (no business logic execution).
- Keep server logic minimal; rely on Postgres + RLS for security.

### Non-goals

- Prevent inference via shared state. If hidden state influences writes to shared rows, the shared rows can reveal derived information; this is application-dependent.
- Fully specify the RLS policy patterns for `action_records` / `action_modified_rows` (tracked separately in `docs/planning/todo/0004-rls-policies.md`).

## Convergence Target

Synchrotron converges **per user view**:

- For any given user (as defined by role/tenant context + RLS policies), all replicas converge to the same state *as seen by that user*.
- Different users may observe different overall database contents due to RLS (expected).

This is the practical meaning of “mostly invisible SYNC”: SYNC patches for private rows are filtered by RLS and do not appear to users who cannot see those rows.

## Definitions

For a base action record `A` and a user `u`:

- `P_base(A, u)`: the set of forward patches (`action_modified_rows`) attached to `A` that are visible to `u` (after RLS filtering).
- `P_sync(A, u)`: the union of forward patches from all SYNC actions that “correct” `A` and are visible to `u`.
- `P_known(A, u) = P_base(A, u) ∪ P_sync(A, u)`: everything `u` currently knows should happen “because of `A`”.
- `P_replay(A, u)`: the patches produced locally by replaying `A`’s action code on a replica under user `u`.

We treat patches at the level of `(table_name, row_id, operation, forward_patches)` with per-column semantics.

## Proposed SYNC Semantics (Additive / Monotonic)

### SYNC action shape

A SYNC action record:

- Has a reserved `_tag` (name TBD; prototype uses `_InternalSyncApply`).
- Stores `corrects_action_id: A.id` (and optionally `basis` metadata) in `args`.
- Has associated `action_modified_rows` that represent the corrective patches.

### Emission rule

After replaying `A`, compute a patch delta:

`Δ(A, u) = P_replay(A, u) − P_known(A, u)`

Where subtraction means “keep only row/field effects that are not already present in `P_known`”.

If `Δ(A, u)` is non-empty, emit a SYNC action whose patches are exactly `Δ(A, u)`.

Intuition: a user emits a SYNC action only to add *new* effects it can justify from its view, not to overwrite effects already agreed upon (for that user view).

### Why this helps

- If two replicas have the same user view, they should compute the same `P_replay(A, u)` and therefore either emit no SYNC or emit equivalent `Δ`; this prevents “ping-pong” corrections in the common case.
- If a replica has more private rows visible, it can emit additional patches affecting those private rows; other users won’t see them.

## Shared-row Caveat (When SYNC is not “invisible”)

If hidden/private state influences writes to shared rows (rows visible to multiple users), then different users can compute different `P_replay(A, u)` for the same shared row.

That leads to two risks:

- **Visibility**: SYNC patches to shared rows are visible and can leak derived information.
- **Churn**: multiple users can legitimately keep emitting different corrections to the same shared fields.

Proposed stance:

- Document this as an application-level design constraint: actions should avoid using hidden/private state to determine writes to shared rows (or accept the implications).
- If we later want to support this robustly, we likely need an explicit deterministic winner/precedence rule and stronger dedupe semantics.

## Ordering Requirements

SYNC actions participate in the global history and must be ordered *after* the base action they correct.

Practical requirement:

- Before emitting a SYNC action for `A`, the replica must merge/advance its clock based on `A.clock`, then increment for the new SYNC action.

This ensures the SYNC action is causally after `A` in replay order.

## Deduplication (Open Design)

Multiple replicas with the same view can emit identical `Δ(A, u)`. We should define a dedupe strategy, e.g.:

- Add `corrects_action_id` + `delta_hash` and a uniqueness constraint.
- Or generate deterministic SYNC action IDs based on `(corrects_action_id, delta_hash)`.

The prototype currently relies on “append-only log” semantics; this needs tightening to keep growth bounded.

## RLS Requirements (Underspecified Today)

To avoid leaking private data through the sync tables:

- `action_modified_rows` visibility must be constrained so a user only sees patch rows for data rows it can see.
- `action_records` visibility/args must not leak sensitive data:
  - either scope `action_records` similarly,
  - or require that `args` contain no sensitive payload (only identifiers + captured nondeterminism that is safe to reveal to the users who can see the action).

This project needs a concrete, recommended pattern for RLS on the sync tables.

## Testing Plan

- Additive private divergence:
  - One user replays `A` with additional private rows and emits SYNC that only touches those rows.
  - Users who cannot see those rows do not receive patches and their visible state remains consistent.
- No ping-pong within a single user view:
  - Two replicas with identical visibility both replay and do not generate alternating SYNC actions for the same base action.
- Ordering:
  - Ensure SYNC actions sort after their base action in the canonical replay order.

## Open Questions

- Should SYNC patches be allowed to overwrite existing `P_known` effects for shared rows, or should we treat that as “unsupported / discouraged”?
- What is the minimal schema change to support robust dedupe?
- What RLS policy pattern do we recommend for `action_modified_rows` given `(table_name, row_id)`?
