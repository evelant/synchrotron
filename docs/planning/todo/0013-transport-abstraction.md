# 0013 — Transport abstraction (pluggable remote ingress)

## Status

Implemented (v1): `requestSync()` + explicit meta-only fetch + examples updated

## Implementation notes (Jan 2026)

We implemented the first “core-owned ingestion” slice:

- `sync-core` owns a single ingestion helper (`ingestRemoteSyncLogBatch`) that persists remote batches into
  `action_records` / `action_modified_rows` with idempotent + upgrade-safe semantics.
- `SyncService.performSync()` ingests the `fetchRemoteActions()` payload before applying (epoch/retention checks run first).
- The RPC client transport (`SyncNetworkServiceLive`) is now fetch-only (no DB writes).
- Electric ingress uses the core ingestion helper (no duplicated table-write SQL).

What’s still pending is promoting the doc’s stream-first `SyncIngress.remoteBatches` contract into a
first-class service so push + pull transports can be swapped/composed without any bespoke wiring.

Update (Feb 2026): v1 refinement implemented:

- Added `SyncService.requestSync()` (single-flight + coalescing) so transports/examples can trigger sync safely.
- Made server meta fetch explicit by adding `FetchRemoteActions.mode = "full" | "metaOnly"`; Electric mode now
  calls `FetchRemoteActions(mode="metaOnly")` instead of relying on a cursor hack.
- Updated Electric ingress + example apps to call `requestSync()` without hand-rolled “already syncing” mutexes.
- Added a focused unit test to validate `requestSync()` burst coalescing and non-overlap.

## Summary

Synchrotron’s correctness model is DB-driven:

- Remote history lives in local `action_records` / `action_modified_rows`.
- Materialization/apply runs off `findSyncedButUnapplied()` (not off transient network responses).
- Upload is head-gated by `basisServerIngestId`.

Electric was chosen for demo convenience (realtime replication out of Postgres), but it must remain optional. We should define a small **ingress interface** so consumers can plug in alternative delivery mechanisms (polling, SSE/WebSocket, Supabase Realtime, bespoke replication) without rewriting sync logic. Uploads remain RPC (`sendLocalActions`) and are not part of this abstraction.

## Problem

Today, “transport” is not a clean boundary:

- RPC polling lives in `SyncNetworkService` and is coupled to HTTP-RPC details.
- Remote ingestion used to be duplicated across transports (RPC + Electric) and required each transport to understand the internal sync tables + JSON binding quirks.
- Electric ingress is a separate service that triggers sync when shapes are caught up, but its table-write path should be shared with other ingress mechanisms.

This makes it hard to:

- swap transports cleanly
- reason about “one ingress pipeline”
- add new transports without copying a lot of internal wiring

It also means “push ingress transports” (Electric, SSE/WebSocket, etc) must choose how to trigger sync.
Historically (pre-`requestSync()`), Electric called `SyncService.performSync()` directly when shapes were caught up.
This was reasonable, but without a shared helper it risked:

- sync storms (calling sync on every ingress batch)
- concurrent `performSync()` overlap (wasted work + extra contention)
- duplicated “single-flight” logic across transports/examples

## Goals / Non-goals

### Goals

- A consumer can provide _one_ Effect `Layer` implementing a transport contract and “it just works”.
- Keep correctness DB-driven (sync tables remain the ingress queue).
- Allow both push and pull transports.
- Make the contract explicit about what the transport must provide (history rows + cursor semantics).

### Non-goals

- Implement the refactor in this doc.
- Solve “malicious client” defenses (assume honest clients + base-table RLS boundary for v1).
- Abstract away Postgres concepts entirely (e.g. `server_ingest_id` stays part of the model for now).

## Proposed direction (v1): transport-triggered sync + `requestSync()` + explicit server meta

### Decision: transport-triggered sync is supported

It is a supported pattern for an ingress transport to “kick” the sync runtime after it ingests remote rows.

However, transports should call **`SyncService.requestSync()`** (new public helper), not `performSync()`
directly. This provides:

- single-flight `performSync()` execution (no concurrent overlap)
- burst coalescing (many triggers → fewer actual sync runs)
- a consistent place to add optional backoff/logging later

### `requestSync()` semantics (v1)

Add a public API:

```ts
SyncService.requestSync(): Effect.Effect<readonly ActionRecord[], unknown, never>
```

Behavior:

- If no sync is running, `requestSync()` starts one `performSync()` immediately.
- If a sync is already running, `requestSync()` coalesces “more work happened” and ensures a follow-up
  `performSync()` runs after the current one completes (rather than running concurrently).
- `requestSync()` completes when the runtime returns to “idle” (no pending requested sync work).
- `requestSync()` does not change sync semantics; it inherits `performSync()`’s existing bounded retry policy
  and error behavior.

Implementation sketch (Effect primitives):

- `Queue.sliding(1)` to coalesce wakeups
- `Ref` for “in sync cycle” / “needs another run” flags
- a single worker fiber draining wakeups and calling `performSync()` until idle
- `Deferred` and/or `Latch` to allow `requestSync()` callers to await “idle after my request”

### Make server meta explicit (remove the “meta-only fetch” hack)

`performSync()` needs server meta on every run (epoch + retained-history watermark).

Today, Electric-enabled clients call `FetchRemoteActions` with `sinceServerIngestId = Number.MAX_SAFE_INTEGER`
to force an empty delta while still getting meta.

Refine the RPC surface so Electric mode can fetch meta without hacks:

- Option A (preferred): add `FetchServerMeta` RPC that returns `{ serverEpoch, minRetainedServerIngestId }`
  (and optionally `headServerIngestId`).
- Option B: add an explicit `mode: "full" | "metaOnly"` param to `FetchRemoteActions`.

### Mapping existing implementations (v1)

- **RPC polling (no Electric):** schedule `requestSync()` periodically and/or call it after local actions.
  `performSync()` already does the fetch+ingest step in polling mode.
- **Electric ingress + RPC upload:** Electric ingests via the core ingestion helper, then calls `requestSync()`
  when both shapes are caught up. RPC remains for upload + server meta.
- **Custom push ingress:** ingest remote sync-log rows into `action_records`/`action_modified_rows` (via the core
  ingestion helper), then call `requestSync()` when caught up.

## Future direction: “stream-first transport” + core-owned ingestion

### Key idea

Transport should be responsible for _delivering_ remote sync-log rows, not _writing_ them into the local DB.

Core should own exactly one ingestion function that persists remote batches into:

- `action_records` (upsert / idempotent)
- `action_modified_rows` (insert / idempotent)

This avoids duplicating “how to write sync tables correctly” across transports.

### Interface sketch

The core algorithm needs one pluggable capability:

1. Remote ingress (receive remote history rows).

Local egress (upload) is always RPC (`sendLocalActions`) and stays in `SyncNetworkService`.

```ts
import type { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"
import type { Stream } from "effect"

export interface RemoteBatch {
	readonly actions: ReadonlyArray<ActionRecord>
	readonly modifiedRows: ReadonlyArray<ActionModifiedRow>
	/**
	 * Optional convenience: max server_ingest_id contained in `actions`.
	 * (Used for diagnostics; the applied cursor remains DB-derived.)
	 */
	readonly maxServerIngestId?: number
	/**
	 * Optional: set by push transports when they know they are “caught up”.
	 * Useful for examples/UX; not required for correctness.
	 */
	readonly caughtUp?: boolean
}

export type SyncTransportError = {
	readonly _tag: "TransportError"
	readonly message: string
	readonly cause?: unknown
}

export interface SyncIngress {
	/**
	 * A stream of remote batches.
	 *
	 * - Polling implementations can use `Stream.repeatEffectWithSchedule(...)`.
	 * - Push implementations can use `Stream.asyncScoped(...)`.
	 * - Duplicates are allowed; ingestion is idempotent.
	 */
	readonly remoteBatches: Stream.Stream<RemoteBatch, SyncTransportError>
}
```

Notes:

- `remoteBatches` is intentionally agnostic to “poll vs push”.
- Cursoring for `remoteBatches` can be internal to the ingress (e.g. it can read `client_sync_status.last_seen_server_ingest_id`), or we can later split the ingress into:
  - `fetchRemoteActions({ sinceServerIngestId, includeSelf })` (pure request/response)
  - plus a library-provided polling runner that converts it into `remoteBatches`

### Ingestion contract (owned by core)

Core-owned ingestion should:

- run in a DB transaction
- be idempotent (safe to receive duplicates)
- be “merge-safe” for rows that originated locally
  - if a local action already exists by id, ingest should not regress it
  - if a remote row carries `server_ingest_id` / `synced=true`, ingest may need to _upgrade_ the local row if it is still unsynced

This becomes the single place to encode DB specifics (SQL dialect differences, upsert strategy, JSON encoding).

### Applying remote batches stays DB-driven

`SyncService.performSync()` continues to:

- discover remote work via `findSyncedButUnapplied()`
- refuse to apply remote actions until their patches are present (prevents spurious CORRECTION deltas)
- advance `last_seen_server_ingest_id` only after apply/reconcile succeeds

So the transport does not need to be “perfectly ordered” or “transactional”, only reliable enough to eventually deliver the rows.

## Mapping existing implementations (stream-first / future)

### RPC polling (no Electric)

- `remoteBatches`: `Stream.repeatEffectWithSchedule(fetchOnce, Schedule.fixed("..."))`
  - `fetchOnce` calls the RPC endpoint (cursor-based) and returns `{ actions, modifiedRows }`.
- Upload remains the existing RPC `SendLocalActions` call (not part of `SyncIngress`).

### Electric ingress + RPC upload (current demo model)

- `remoteBatches`: wrap `TransactionalMultiShapeStream` and emit a `RemoteBatch` when both shapes have advanced (and optionally when `headers.last === true` to set `caughtUp`).
- Upload remains RPC (Electric is ingress-only for sync metadata tables).

This composition suggests we may want a small “combiner” later (e.g. `SyncIngress` from Electric + RPC `SyncNetworkService` for upload/metadata).

## Alternatives considered

### A) “Transport writes sync tables directly” (status quo)

Pros:

- trivial to implement for Electric (it already writes to tables)

Cons:

- forces every transport to understand internal schema and SQL dialect quirks
- encourages duplicated insertion/upsert logic
- makes it harder to prove “one ingress pipeline”

### B) Pull-only interface (no stream)

Pros:

- smallest surface area

Cons:

- forces every app to reinvent scheduling/push-trigger plumbing
- makes “push transport” awkward (it has to emulate polling or expose extra hooks)

### C) “Wakeup-only stream” + pull fetch

Pros:

- push transports can emit wakeups without carrying payloads

Cons:

- still needs a fetch API; adds moving parts vs a single `remoteBatches` stream

## Implementation plan (v1)

1. Add `SyncService.requestSync()` public helper (single-flight + burst coalescing).
2. Refactor Electric ingress to provide `SyncIngress`; core-owned runner ingests + triggers `requestSync()` (not transport code).
3. Replace the Electric “meta-only fetch” hack with an explicit server meta RPC (`FetchServerMeta` or `FetchRemoteActions(mode)`).
4. Update examples to call `requestSync()` rather than hand-rolled mutexes around `performSync()`.
5. Add tests:
   - `requestSync()` coalesces bursty triggers and never overlaps `performSync()`.
   - Electric burst ingress does not cause overlapping sync runs.

## Future follow-ups

- Revisit the stream-first `SyncIngress.remoteBatches` contract once we want a single shared driver that
  owns ingestion+triggering for both push and pull transports.
- ✅ Implemented: standardize ingress as a service + core runner (`docs/planning/todo/0021-sync-ingress-service-v2.md`).
