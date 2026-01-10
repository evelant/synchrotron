# 0002 — Reliable Fetch Cursor (Server Ingestion Watermark)

## Status

Implemented

## Summary

Today, “fetch remote actions since last sync” is based on a **client-generated clock watermark** (e.g. `WHERE compare_hlc(clock, last_synced_clock) > 0`). This is not a safe incremental-fetch strategy because **new actions can arrive later with an earlier clock** (offline / delayed upload) and because **client clocks can drift**.

This issue is independent from the “replay order” key (tracked in `docs/planning/todo/0001-rework-sort-key.md:1`). Even with a perfect replay ordering, we still need a fetch cursor that guarantees we don’t permanently miss actions.

Implemented fix: introduce a **server-generated ingestion cursor** (monotonic) used only for fetching/streaming. Clients fetch by ingestion cursor, then sort/apply by the replay order key.

## Problem Statement

### Previous behavior (pre-0002)

Server-side fetch uses the client’s `last_synced_clock` as a watermark:

- `compare_hlc` compares timestamps first (`packages/sync-core/src/db/sql/clock/compare_hlc.sql:11`)
- server queries used `compare_hlc(clock, lastSyncedClock) > 0` (now removed)

This assumes: “anything new-to-this-client must also have a clock greater than the last seen clock”.

That assumption is false in two common scenarios:

### Failure case A — Clock drift (fast client)

If client A’s clock is +10 seconds fast, A’s `last_synced_clock.timestamp` can move ~10s into the “future” relative to other clients. Then:

- actions authored by other clients during that gap look “older” (timestamp < A’s watermark)
- A won’t fetch them until wall-clock time catches up (delayed visibility)
- if server-side pruning happens before catch-up (or drift is large), this can become a permanent miss

### Failure case B — Late-arriving offline actions (permanent miss)

Client B can create actions while offline with timestamps that are earlier than A’s current watermark. When B later uploads them, they are inserted “in the past” (by replay clock), so:

- `compare_hlc(clock, last_synced_clock) > 0` is false forever
- A will never fetch these actions at all (permanent hole), even though they are new rows on the server

This can happen even with “perfect” clocks; it’s fundamentally about *late arrival*.

## Goals / Non-goals

### Goals

- Never permanently miss remote actions due to drift or late arrival.
- Keep the replay order semantics client-generated (no server-assigned replay ordering).
- Keep the server implementation minimal and index-friendly.
- Work both for “plain HTTP fetch” and test harnesses; be compatible with ElectricSQL usage.

### Non-goals

- This does not change conflict resolution, rollback, or replay order. Those remain clock-based (see `0001`).
- This does not attempt to guarantee fairness or “true real-world time” ordering across clients.

## Proposed Approach: Server Ingestion Cursor

Introduce a server-maintained, monotonic cursor that reflects **when the server learned about an action**, not when the action “happened” by client clock.

Clients:

1. Fetch “all actions with `ingest_id > last_seen_ingest_id`”.
2. Sort/apply those actions by the replay order key (clock-derived).
3. Persist the new `last_seen_ingest_id` watermark.

### Why this works

- Late-arriving offline actions are still “new” by ingestion cursor, even if their replay clock is old.
- Drifted client clocks no longer control “what is new”; they only affect replay ordering.

### Options for the ingestion cursor

Option A (implemented): `server_ingest_id` assigned on ingest

- Add `server_ingest_id BIGINT` to `action_records`.
- Server assigns it on insert using a monotonic sequence (`action_records_server_ingest_id_seq`) and `nextval(...)`.
- The column is nullable so clients can store local-only actions without a server cursor value.
- Index it and use it as the cursor.

Option B: `(server_received_at, id)` cursor

- Add `server_received_at TIMESTAMPTZ NOT NULL DEFAULT now()` and use `(server_received_at, id)` as the cursor.
- Requires careful tie-breaking; timestamps can collide.

Option C: ElectricSQL/WAL cursor (if Electric is always present)

- If ElectricSQL is the only transport, the replication stream already has an inherent ordering (LSN/tx).
- If we still support non-Electric “fetch since”, we still need an explicit cursor.

## Data Model / Schema Changes

Files:

- `packages/sync-core/src/db/sql/schema/create_sync_tables.sql`

Proposed additions:

- `action_records.server_ingest_id BIGINT`
  - assigned by the server on ingest via `nextval('action_records_server_ingest_id_seq')`
  - `CREATE INDEX ... ON action_records(server_ingest_id)`
  - `CREATE UNIQUE INDEX ... ON action_records(server_ingest_id) WHERE server_ingest_id IS NOT NULL`
- Optional: `action_records.server_received_at TIMESTAMPTZ NOT NULL DEFAULT now()` for debugging/analytics.

Client state:

- Add a persisted watermark for the last seen server ingestion cursor (likely in `client_sync_status`):
  - `last_seen_server_ingest_id BIGINT NOT NULL DEFAULT 0`

Migration/backfill:

- Not implemented (experimental): reset local/dev DBs if you have pre-0002 data.
- Important: this is not replay order; it is only “arrival order”.

## Code Touchpoints

Server:

- `packages/sync-server/src/SyncServerService.ts`
  - `getActionsSince(...)` should accept a `since_ingest_id` and query:
    - `WHERE server_ingest_id > $since AND client_id != $clientId`
    - `ORDER BY server_ingest_id ASC` (fetch order)
  - The server can still return actions ordered by replay key, but it’s usually cheaper to fetch by ingestion and let the client sort for replay.

Client/core:

- Store `last_seen_server_ingest_id` in `client_sync_status` and expose accessors (implemented in `ClockService`).
- Update network fetch to pass `sinceServerIngestId` and have the server filter by `server_ingest_id`.
- After a successful remote apply, advance the watermark to the max `server_ingest_id` seen in that fetch batch.

Tests:

- `packages/sync-core/test/helpers/SyncNetworkServiceTest.ts` (server simulation now uses `server_ingest_id` watermark)
- Regression test for late-arriving actions: `packages/sync-core/test/fetch-cursor.test.ts`
  - Insert action A, advance watermark past it
  - Later insert action B with an older `clock.timestamp` but higher `server_ingest_id`
  - Verify client fetch returns B

## Testing Plan

1. **Regression: late arrival**
   - Demonstrate current behavior misses the action when using `compare_hlc` watermark.
   - Demonstrate new ingestion-cursor fetch returns it.
2. **Regression: drift**
   - Set a client watermark clock in the future; ensure ingestion-cursor fetch still returns newly ingested actions.
3. **End-to-end sync tests**
   - Run the existing sync-core tests; add a scenario that simulates offline creation + delayed upload.

## Rollout Plan

1. Add schema + sequence + index.
2. Update server fetch API (and tests) to use ingestion cursor.
3. Update client to store and advance ingestion cursor.
4. Remove the old clock-watermark fetch (no backwards compatibility required).

## Open Questions

- Where should the cursor live?
  - Client-local DB (`client_sync_status`) is simplest for single-tenant clients.
  - Server-side per-client state can work too, but adds server storage/identity concerns.
- ElectricSQL integration:
  - If Electric becomes the only supported transport, we may not need a separate ingestion cursor for steady-state streaming (but still useful for non-Electric fallback and for tests).
