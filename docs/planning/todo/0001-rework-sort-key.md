# 0001 — Rework Action Sort Key (Indexable HLC Triple)

## Status

Proposed

## Summary

The system currently relies on `action_records.sortable_clock` (a text key derived from the JSONB `clock`) as the “global replay order” and as the basis for rollback/common-ancestor selection. That key is computed via a heuristic (`compute_sortable_clock`) which:

- Is not a faithful encoding of the clock’s causal relationship (it can collide / lose information).
- Has historically diverged between TypeScript ordering and SQL ordering.
- Is used in many critical SQL paths (`ORDER BY`, common-ancestor, rollback), so any discrepancy undermines determinism.

This change introduces a **canonical, index-friendly, deterministic total order key** for actions:

`(physical_time_ms, logical_counter, node_id, action_id)`

and rewires all “replay order” logic to use it consistently across TypeScript and SQL.

## Fresh Session Checklist (Start Here)

1. Baseline sanity:
   - Run `pnpm -C packages/sync-core test` (record failures before changes).
   - Run `rg -n "sortable_clock|compute_sortable_clock|compare_hlc" packages docs` to re-locate all touchpoints (update this doc if new ones appear).
2. Make the key decision up front (document the chosen values in this doc):
   - Timestamp handling: use raw `clock.timestamp` ms (no bucketing).
   - `logical_counter` source of truth: derived from `clock.vector[client_id]` vs stored explicitly.
3. Confirm invariants we’re relying on:
   - `HLC.createLocalMutation` increments the local counter monotonically.
   - `HLC.receiveRemoteMutation` ensures the local counter is ≥ observed counters (so ordering doesn’t go “backwards” for a node).
4. Agree on acceptance criteria:
   - All SQL `ORDER BY sortable_clock` / `sortable_clock < >` paths are migrated to the new key.
   - TS sorting and SQL ordering match for the same set of actions.
   - `find_common_ancestor()` and `rollback_to_action()` behave deterministically under concurrency.

## Why We’re Doing This

### Problems with the current `sortable_clock`

- **Heuristic / lossy**: today’s `compute_sortable_clock(clock)` uses a “max counter + key rank + key” approach. Different vectors can map to the same `sortable_clock`, and the induced order is not guaranteed to be a linear extension of causal order.
- **Cross-layer consistency risk**: ordering exists in multiple places (TS sorting, SQL `ORDER BY`, SQL functions using `<`/`>` on `sortable_clock`). Any mismatch causes divergent replay order across client/server and makes rollback/common-ancestor selection fragile.
- **Performance pressure**: we need an ordering key that is *indexable* for fast `ORDER BY` / pagination. Doing “real” comparisons over JSONB vectors inside queries is too slow and hard to index.

### What we want instead

- A deterministic, stable, cross-platform “replay order” that is cheap to sort on in SQL (btree index).
- A definition that is easy to implement identically in TS and SQL and easy to test.
- A key that doesn’t require scanning JSONB vectors inside queries.

## Proposed Canonical Replay Order

Define the replay order key for an `action_records` row as:

1. `physical_time_ms`: `clock.timestamp` in milliseconds (UTC epoch ms, client-provided)
2. `logical_counter`: a scalar, monotonically increasing counter for the originating node
3. `node_id`: the originating node (use `action_records.client_id`)
4. `action_id`: `action_records.id` as a final deterministic tie-breaker

### How to compute each field

- `physical_time_ms`
  - `clock.timestamp` in ms (no bucketing).

- `node_id`
  - `action_records.client_id`

- `logical_counter`
  - Primary definition: `clock.vector[node_id]` (default `0` if missing)
  - This relies on an invariant in our clock algorithm: **after merges, the local node’s counter is >= any observed counter**, so causal successors will not end up with a smaller logical counter than their causal predecessors.
  - This is the key difference from “standard” vector clocks: we intentionally embed a scalar logical component into the vector by “adopting the max” on receive.

- `action_id` tie-breaker
  - Even if `(bucket, counter, node_id)` should be unique in practice, `action_id` guarantees uniqueness and prevents accidental equality from collapsing distinct actions.

### Ordering comparison

Lexicographic ordering:

`(time_ms, counter, node_id, action_id)` ascending

This gives us:

- A deterministic total order.
- A cheap, indexable `ORDER BY` in SQL.
- A cross-layer invariant we can test directly.

## Scope / Non-goals

In scope:

- Replace `sortable_clock` as the authoritative ordering mechanism.
- Make replay ordering consistent across TS + SQL.
- Update all SQL functions and queries that use `sortable_clock` ordering/comparisons.
- Add tests to pin ordering correctness and cross-layer consistency.

Explicitly not solved by this change (but should be tracked):

- **“Fetch since last sync” correctness under clock drift / late arrivals**. Without a server-assigned ingestion cursor, any client-generated clock can miss late-arriving actions unless we overlap windows + de-dupe (or maintain a separate receipt watermark). Tracked separately in `docs/planning/todo/0002-reliable-fetch-cursor.md:1`.

## Code & Schema Touchpoints

### SQL schema / triggers

Files:

- `packages/sync-core/src/db/sql/schema/create_sync_tables.sql`

Plan:

- Add new columns on `action_records` (names TBD):
  - `clock_time_ms BIGINT NOT NULL`
  - `clock_counter BIGINT NOT NULL`
  - `clock_node_id TEXT NOT NULL` (or just reuse `client_id` in the index)
- Add a trigger function to populate these on `INSERT/UPDATE` from `NEW.clock` + `NEW.client_id`.
- Add a composite index for fast ordering:
  - `CREATE INDEX ... ON action_records(clock_time_ms, clock_counter, client_id, id);`
- Keep `sortable_clock` temporarily for backward compatibility, but stop using it for correctness-critical ordering.

Also update the sync-status sortable fields if they are still needed:

- `client_sync_status` currently maintains `sortable_current_clock` / `sortable_last_synced_clock`.
- Decide whether we still need sortable representations there, or whether we should store `(bucket,counter,node)` (or a dedicated last-seen action cursor).

### SQL functions that assume `sortable_clock`

Files:

- `packages/sync-core/src/db/sql/action/find_common_ancestor.sql`
- `packages/sync-core/src/db/sql/action/rollback_to_action.sql`

Plan:

- Replace `ORDER BY ... sortable_clock` with `ORDER BY clock_time_ms, clock_counter, client_id, id`.
- Replace comparisons like `a.sortable_clock < ena.sortable_clock` with tuple comparisons (or equivalent lexicographic WHERE clauses).

### Server queries

Files:

- `packages/sync-server/src/SyncServerService.ts`

Plan:

- Replace `ORDER BY sortable_clock ASC` with `ORDER BY clock_time_ms, clock_counter, client_id, id`.
- Re-evaluate any place that mixes `compare_hlc(...)` filtering with ordering by a different key (this was a prior source of subtle inconsistency).

### Client/core queries

Files:

- `packages/sync-core/src/ActionRecordRepo.ts` (many `ORDER BY sortable_clock`)
- `packages/sync-core/test/helpers/SyncNetworkServiceTest.ts` (server simulation queries)
- `packages/sync-core/src/SyncService.ts` (logic that assumes `sortable_clock` total order is “clock order”)

Plan:

- Update all `ORDER BY sortable_clock` / `DESC` cases to the new composite ordering.
- Ensure any “latest/earliest” semantics match the new canonical order.
- Avoid relying on “clock equality” via sort-key equality (see testing section).

### TypeScript clock ordering API

Files:

- `packages/sync-core/src/HLC.ts`
- `packages/sync-core/src/ClockService.ts`

Plan:

- Introduce an explicit **total-order comparator** for actions that includes `node_id` (client id) and `action_id` as tiebreakers.
- Stop using `HLC.equals` as “same clock” if it is implemented in terms of total-order comparison. Structural equality should remain structural (timestamp + vector).
- Expect to touch call-sites like `SyncService.performSync` that currently do `pendingActions.find(a => HLC.equals(a.clock, latestPendingClock))`.

## Testing Plan

### 1) Unit tests (TypeScript)

- **Key derivation**: given `(clock, node_id)`, compute `(time_ms, counter, node_id)` and confirm:
  - `counter === clock.vector[node_id] ?? 0`
  - `time_ms === clock.timestamp`
- **Invariant test** (if we rely on it): for clocks produced by our merge algorithm, confirm the local node counter is >= all observed counters.

### 2) Cross-layer consistency tests (TS ↔ SQL)

Update/replace the existing consistency test:

- `packages/sync-core/test/clock-ordering-consistency.test.ts`

Test idea:

- For a set of generated actions with `(clock, client_id, id)`:
  - Insert into a test DB.
  - Query `ORDER BY clock_time_ms, clock_counter, client_id, id`.
  - Compare to TS sorting using the same comparator.

Add edge cases:

- Same timestamp, same counter across different nodes (tie-break by `client_id`, then `id`).
- Ensure no accidental equality collapse: two distinct actions must still have deterministic order via `id`.

### 3) Regression tests for “ordering-sensitive” SQL

Add targeted tests around:

- `find_common_ancestor()` correctness when actions are interleaved across nodes.
- `rollback_to_action()` selecting the correct set of actions to reverse in strict reverse replay order.

### 4) Full test suite runs

- `pnpm -C packages/sync-core test`
- `pnpm -C packages/sync-server test` (if present)

## Migration / Rollout Plan

1. **Add new columns + trigger** (non-breaking).
2. **Backfill** existing rows:
   - `UPDATE action_records SET clock_bucket = ..., clock_counter = ... WHERE clock_bucket IS NULL ...`
3. **Switch reads/ordering** in code to the new composite key everywhere.
4. Keep `sortable_clock` temporarily:
   - It may still exist for old clients or debugging.
   - Optionally add a temporary assertion/test that `sortable_clock` order equals composite order (until removed).
5. Once stable, **deprecate/remove** `sortable_clock` and its trigger/index.

## Open Questions / Decisions Needed

- (Deferred) **Timestamp bucketing**: we are not bucketing timestamps initially. If drift sensitivity becomes a real user-visible issue, revisit with a clear, app-driven rationale.
- **Cursor semantics**: do we keep `last_synced_clock` as a causal frontier (vector) for fetch filters, or do we add a dedicated “last seen action order key” cursor? (Without a server receipt cursor, we may still need overlap + de-dupe.)
- **Model shape**: do we keep `clock` as `{timestamp, vector}` and derive order fields, or do we evolve the clock model to include explicit `(l,node)` fields?
