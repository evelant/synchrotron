# 0014 — Dev/test action purity check (optional)

## Status

Proposed (optional)

## Summary

Actions are expected to be deterministic (repeatable on the same DB snapshot given the same args). If an action is accidentally nondeterministic (wall clock, random, non-deterministic SQL, implicit ordering, etc), SYNC deltas can “paper over” the bug and convergence still happens, but the system becomes hard to reason about and can leak information via shared-field overwrites.

This TODO proposes an **opt-in dev/test-only purity check** that replays the same apply batch twice against the same snapshot and asserts the resulting captured patches are identical.

This is _not required for library correctness_ (the system can converge without it); it’s a developer ergonomics + diagnostics tool.

## What we want (behavior)

- When enabled (CI/dev only), detect non-repeatable action replay on the same snapshot.
- Surface a loud diagnostic (log/error with action ids/tags and a diff preview).
- Prefer “diagnostics only” first; do not change sync semantics unless we have a strong reason.

## Constraints / complications

- Patch capture is tied to an `action_record_id` capture context; rerunning a batch will naturally generate different action ids unless we carefully structure the check.
- We need a reliable way to return the DB to the exact same state between runs:
  - Postgres: `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` is the natural tool.
  - SQLite/pglite: needs confirmation of savepoint behavior + interaction with triggers; may require careful scoping.
- The check must not mutate the durable action log (it should not create new persisted actions/AMRs).

## Possible designs

### A) Batch-level savepoint in `applyActionRecords` (preferred if feasible)

At the start of applying a remote batch:

1. Create a placeholder `_InternalSyncApply` record (already done today).
2. Run replay once under the placeholder capture context; collect generated AMRs for the placeholder.
3. `ROLLBACK TO SAVEPOINT` (or otherwise restore snapshot).
4. Re-run replay again (same remote batch, same ordering); collect generated AMRs again.
5. Compare the two generated patch sets (final row effects, like the existing delta logic).
6. If they differ:
   - log a structured “purity violation” diagnostic (likely `ERROR`)
   - optionally attach an in-memory “sync unhealthy” flag for the UI/tests

Notes:

- This requires that both runs can reuse the same capture context or otherwise normalize away differing capture ids.
- We may need to run with patch capture disabled except for the placeholder (already the case).

### B) Test-helper wrapper (minimal intrusion)

Provide a helper in tests that:

- runs a single action/batch twice inside a transaction + savepoint (using raw SQL),
- compares captured AMRs,
- fails the test if they differ.

This avoids touching core runtime code until we’re confident in ergonomics and cross-dialect behavior.

## Where this fits relative to other TODOs

- `0003` and `006` describe SYNC delta semantics and shared-field overwrite cases. Purity checks help diagnose the “impure action” subset, but they should not be required to ship core sync semantics.

## Open questions

- Should purity violations be “diagnostics only” (recommended), or should they stop sync / suppress overwriting deltas?
- Is savepoint support consistent across our supported DBs (pglite/sqlite)?
- If we want to add a runtime flag, what should the configuration surface look like (Effect `Config`, explicit option on `makeSynchrotronClientLayer`, etc)?
