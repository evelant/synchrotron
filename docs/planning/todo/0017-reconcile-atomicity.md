# 0017 — Reconcile atomicity (crash-consistency for rollback + replay)

## Status

Implemented (Jan 2026)

## Problem

Synchrotron’s client reconciliation involves a **rollback** to a common ancestor and then a **replay** of the action history in canonical order. If these steps are not atomic, a crash (or an error mid-reconcile) can leave the client’s local DB in an intermediate state that is difficult to reason about:

- base tables rolled back, but not replayed (“empty/old UI state” after a failed sync attempt)
- `local_applied_action_ids` no longer matches the materialized base-table state
- a local `RollbackAction` marker may be inserted even if the replay never successfully completed

This is especially visible when replay fails due to an unknown remote `_tag` (“Missing action creator …”) or other replay-time failures.

## Current behavior (are transactions split?)

As of Jan 2026: **no** — reconcile/rematerialize are wrapped in a single outer transaction, so rollback + rollback-marker insert + replay commit (or roll back) together.

Historical note: before this change, reconcile could persist a “rolled back but not replayed” state because rollback and replay were executed in separate top-level transactions, with the rollback marker inserted between them.

### Note on nested `withTransaction`

`@effect/sql` _does_ support nesting: nested `SqlClient.withTransaction` reuses the outer transaction and uses `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` (commit only happens at the outermost transaction boundary). This means we **can** add an outer transaction boundary around reconcile and still safely call helpers that currently use `withTransaction`.

This only helps if an outer `withTransaction` exists — reconcile/rematerialize now add that outer boundary so rollback + marker + replay are atomic.

## Goal

Make “rollback + rollback-marker insert + replay” **atomic** for client-side reconciliation and rematerialization:

- If reconcile succeeds: commit once and advance state.
- If reconcile fails: leave the client DB exactly as it was before attempting reconcile (no persisted rollback, no persisted rollback marker, no partial replay).

Non-goal: include network calls (RPC upload/fetch) in the DB transaction.

## Approach

Add an explicit **outer DB transaction** for each “rollback + replay” operation, and ensure the rollback marker insert happens inside it.

- Reconcile: wrap rollback-to-common-ancestor + rollback marker insert + replay under a single `sqlClient.withTransaction`.
- Remote-only rematerialize: wrap rollback-to-target + marking rollback markers as applied + replay under a single `sqlClient.withTransaction`.

Follow-up (optional): split rollback/apply helpers into `*InTx` + wrapper variants to avoid nested savepoints and make transaction boundaries more explicit in the code.

## Test plan (regression-driven)

Add a test that triggers reconcile and forces replay failure, asserting no partial rollback persists:

- Setup:
  - client “receiver” has a local pending action applied to base tables
  - server provides a remote action with an older clock (forces reconcile), then mutate its `_tag` to an unknown tag (like the existing unknown-action tests)
- Expect:
  - `performSync()` fails
  - base-table state is unchanged from pre-sync attempt (local pending effects still visible)
  - no `RollbackAction` record was persisted as unsynced work
  - `local_applied_action_ids` still contains the local pending action ids

Add a second test for the “remote-only rematerialize” path if we make that atomic in the same change.

## Implementation notes

- Reconcile is now wrapped in a single outer `SqlClient.withTransaction` in `packages/sync-core/src/sync/SyncServicePerformSyncCases.ts`.
- The “remote-only rematerialize” path (rollback target defined) is also wrapped in a single outer `SqlClient.withTransaction` in the same module.
- Regression test: `packages/sync-core/test/sync/reconcile-atomicity.test.ts`.

## Open questions

- Should we also make cursor advancement (`last_seen_server_ingest_id`) happen inside the same transaction as replay, or keep it as-is?
- Are there any client DB adapters/drivers we use where `SAVEPOINT` is not supported (given `@effect/sql` uses it for nested transactions)?
