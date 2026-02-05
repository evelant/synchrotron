# 0020 — Replay creates extra/new rows on non-originating clients

## Status

Implemented (additive + subtractive, with patch-authoritative fallback)

## Summary

Synchrotron applies remote actions by replaying business logic locally. When replay produces **additional
effects** beyond the patches received for the remote action (often due to private/conditional logic), the
client emits a patch-only **CORRECTION** action to converge.

This doc focuses on “existence divergence” in the _additive_ direction:

> Replay on a non-originating client creates extra/new rows that were not present in the incoming patch
> set for the base action.

It also notes the related “subtractive” corner case (replay produces fewer effects than the incoming
patch set) because it influences what we should test and what constraints we document.

## Background (current behavior)

- On apply, the client:
  1. creates a placeholder local CORRECTION record to capture replay patches,
  2. replays incoming actions (and applies received CORRECTION patches directly),
  3. computes a delta: `P_replay(batch) − P_known(batch)` (known = base patches + received CORRECTIONs),
  4. keeps/deletes the placeholder accordingly.
     See `packages/sync-core/src/sync/SyncServiceApply.ts` and `packages/sync-core/src/sync/SyncServiceApplyDelta.ts`.
- The delta algorithm is currently oriented around **replay-produced effects** (it iterates the rows
  touched by replay).

## The problem

### A) Additive existence divergence (the intended CORRECTION use case)

Replay can produce additional inserts/updates when:

- the action branches on state that differs across replicas/views (private/conditional logic),
- a replica has access to additional rows and therefore takes additional branches,
- late-arriving history changes the basis state during rollback+replay and exposes new effects.

If these additional rows should exist for the current replica’s view, we need to ensure they are captured
and propagated (subject to RLS) so that replicas that _should_ see them converge.

### B) Subtractive existence divergence (the scary corner case)

If the incoming patch set contains an INSERT/UPDATE for row `X` but replay does **not** produce `X`, then:

- the delta computation (`P_replay − P_known`) will not “invent” a compensating patch for `X` (because `X`
  is absent from the replay patch set),
- if we do nothing, base-table state can diverge permanently from the visible action log.

This can happen if hidden/private state influences _shared_ row existence. If we consider that pattern
unsupported, we should document and detect it loudly.

#### Implemented resolution (patch-authoritative for missing base effects)

Treat `P_known` as authoritative for any **base** row keys that are present in the received base patch set
but missing from replay-generated patches:

- Compute missing row keys as: `rowKeys(originalBasePatches) − rowKeys(replayGeneratedPatches)`.
- Patch-apply the known patch sequence for those row keys (base + any received CORRECTIONs) with patch
  tracking disabled, so base tables converge even when replay omits effects.
- Do **not** emit an outgoing CORRECTION for these missing effects (delta remains directional: `generated − known`).

Implementation: `packages/sync-core/src/sync/SyncServiceApply.ts`.

## What we need to decide / specify

### 1) What is the contract for “extra rows on replay”?

Proposed contract:

- Extra rows produced on replay are **captured** by the placeholder CORRECTION record’s patches.
- If those rows are not already implied by known patches, the client emits a CORRECTION action containing
  the missing inserts/updates/deletes.
- Other replicas apply that CORRECTION as patches (no action code), so they converge even if their own
  replay wouldn’t have created the rows.

### 2) How does this interact with deterministic ids?

Extra rows must still have stable ids for the replicas that will reference them.

- Stable-id guidance is tracked in TODO `0019`.
- If extra rows are “derived/per-view” and never referenced by shared actions, id stability is less strict.

### 3) How do we treat subtractive divergence?

Options (to brainstorm; not implementing now):

- Treat as **unsupported** (private influences shared existence) and add loud diagnostics.
- Extend delta computation to include `P_known − P_replay` cases (i.e. emit deletions / reintroduce known
  inserts), which would make patches partially authoritative and needs careful semantics.
- Rely on bootstrap/rebase to eventually realign (not ideal as a correctness story).

## Test plan ideas

Add at least one explicit regression test for additive existence divergence:

- Action A runs on origin and touches only a shared row (or a base row).
- On another client, replay of A creates an **additional INSERT** into some table (either shared or private),
  producing an outgoing CORRECTION action with an INSERT AMR for the new row.
- Assert:
  - the CORRECTION is emitted and uploaded,
  - another client that never would have created that row via replay still receives it via CORRECTION and
    ends up with the row present (when visible).

Implemented regression tests:

- `packages/sync-core/test/sync/replay-creates-extra-rows.test.ts`
- `packages/sync-core/test/sync/replay-creates-extra-rows.sqlite.test.ts`
- `packages/sync-core/test/sync/replay-omits-known-effects.test.ts`
- `packages/sync-core/test/sync/replay-omits-known-effects.sqlite.test.ts`

Add a diagnostic/constraint test for subtractive divergence (if we decide it’s unsupported):

- Incoming patches include an INSERT for a visible row, but replay does not create it.
- Assert we surface a loud error/diagnostic (and document it).

## Open questions

1. Should we also detect/repair “missing columns” cases (known sets a value that replay doesn’t write) as a
   separate guardrail from existence-level missing row keys?
2. Should we add a dev-mode “existence divergence detector” (metrics/alerts) similar in spirit to the purity
   check TODO (`0014`)?
