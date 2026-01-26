# 006 — SYNC Conflict: Shared-Field Overwrites (Divergent Views + Purity Bugs)

## Status

Implemented (with follow-ups possible)

## Summary

Synchrotron’s SYNC mechanism (“emit a patch-only delta when replay produces different effects”) is designed to handle _private-data divergence_ under RLS and is mostly additive.

There is a narrow but important corner case where SYNC deltas become **visible overwrites** on shared fields:

- Two replicas legitimately compute **different writes to the same shared `(table,row,column)`** for the same business-action history because their visible state differs (RLS/private rows), or
- Action replay is accidentally **impure / nondeterministic**.

In both cases, the system still converges (SYNC participates in the action log): for a contested shared field, the final value is the value of the **last SYNC action in canonical HLC order** (effectively last-writer-wins for that field).

The problem is not convergence; it’s **semantics + information leakage + developer surprise**, and (in bug cases) diagnosing nondeterminism.

## Background (SYNC = batch delta)

`docs/planning/todo/0003-sync-action-semantics.md` models SYNC emission as a batch delta:

- Apply a batch `B` of actions.
- Replay the non-SYNC actions to produce `P_replay(B, u)` (captured patches).
- Compare against `P_known(B, u)` (received base patches plus any received SYNC patches).
- Emit `Δ(B, u) = P_replay(B, u) − P_known(B, u)` as a new SYNC action if non-empty.

In the intended/private-data case, `Δ` is additive (missing effects on rows/fields filtered by RLS).

## When does shared-field divergence happen?

It requires a specific (and usually undesirable) pattern:

- an action’s replay reads view-exclusive/private state (private row, permission, tenant-specific conditional),
- and uses it to write a field that is shared/visible across views.

Different views can then compute different values for the same shared field.

## Minimal example

Tables:

- `projects(id, status)` — visible to Alice and Bob.
- `private_settings(user_id, preferred_status)` — visible only to its owner.

Action:

- `set_project_status(project_id, timestamp)`:
  - reads `private_settings.preferred_status` for the current user
  - writes `projects.status = preferred_status`

Assume:

- Alice’s `preferred_status = "ALICE"`
- Bob’s `preferred_status = "BOB"`

History:

- One non-SYNC action `A = set_project_status(project_id=1)`

### What happens (and why it still converges)

1. Bob runs `A` and uploads it. Bob’s patches for `A` include `projects(1).status = "BOB"`.

2. Alice receives `A`, replays it, and (given her view) writes `projects(1).status = "ALICE"`.
   - Alice emits a SYNC overwrite `S_ALICE` with patch `projects(1).status = "ALICE"`.

3. Bob later emits a different SYNC overwrite `S_BOB` with patch `projects(1).status = "BOB"`.

4. Replicas converge once they have applied the same log: since SYNC actions are ordered by HLC, the final value is whichever SYNC is last in canonical order.

### Why this does not “ping-pong forever” in steady state

SYNC actions are applied as patches. When a replica receives a later SYNC action, it typically **fast-forwards**: it applies that patch without re-running the earlier business actions that originally caused the divergence.

Repeated flips require repeated rollback+replay across the same history window (e.g. continual late-arriving actions) or action impurity/clock issues.

## Why this is still a problem

- **Information leakage**: shared rows can reflect derived private information.
- **Semantics surprise**: shared-field conflicts effectively become last-writer-wins based on when/which replica emitted the last SYNC.
- **Observability**: overwriting deltas can also be caused by legitimate stabilization (late arrivals) or by nondeterminism; without diagnostics it’s hard to tell which.

## Proposed stance + handling

### 1) Application-level constraint (preferred)

Document and strongly recommend:

- Avoid using view-exclusive/private state to determine writes to shared fields, unless you explicitly accept the leakage + last-writer-wins semantics.

If an app needs this pattern, it should implement an explicit domain-level rule (outside the generic SYNC mechanism) so the “winner” is intentional.

### 2) Loud diagnostics for overwrites (recommended regardless)

Classify `Δ(B, u)` differences into:

- **Missing effects** (common case): replay writes a row/field that is absent from `P_known`.
- **Overwrites**: replay writes a different value for a row/field already present in `P_known`.

When we emit a SYNC containing overwrites, log a diagnostic including:

- `(table,row,column)` and known vs replay previews,
- whether the basis likely changed (rollback+replay / late arrivals) vs “no new non-SYNC inputs” (suspicious),
- the ordered non-SYNC action ids (or a bounded hash) used as the replay basis (optional, for debugging).

Implementation status:

- The client logs structured delta details (missing vs differing columns) when it keeps an outgoing SYNC delta during `applyActionRecords`.
- Overwrites are a distinct severity class in logs: deltas that overwrite known values are logged at `ERROR` and include `hasOverwrites` / `overwriteRowCount` / `missingOnlyRowCount`.
- We do not yet persist diagnostics.

### 3) Purity-bug detection (optional dev/test)

This is not required for core convergence. It’s a developer ergonomics / diagnostics tool (see `docs/planning/todo/0014-dev-test-action-purity-check.md`).

The strongest signal of impurity is non-repeatability on the same snapshot:

- Run the same replay twice against the same DB snapshot (transaction + savepoint/rollback) and assert identical captured patches.

## Tests to add

Already covered:

- **Shared-field overwrite convergence**: `packages/sync-core/test/sync/shared-field-overwrite.test.ts`
  - Two clients with deterministic but view-dependent replay of a shared field.
  - Each can emit a different overwriting SYNC.
  - Replicas converge to the last SYNC in canonical order, and a subsequent sync pass does not emit a new SYNC without new inputs.

Optional / next:

- Persist “sync health” diagnostics (optional; probably a local-only table first).
- Optional (dev/test): add a purity-check regression test (tracked in `docs/planning/todo/0014-dev-test-action-purity-check.md`).

## Open questions

- Do we store any `basis` metadata in SYNC `args` for observability/debugging (bounded list vs hash)?
- Should shared-field overwrites be treated as a hard error by default (since they can leak info), or only a warning?
- How should diagnostics be exposed (logs only vs persisted `sync_health` table)?
