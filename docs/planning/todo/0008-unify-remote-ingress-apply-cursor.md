# 0008 — Unify Remote Ingress + Apply + Cursor Advancement (Electric + RPC)

## Status

Planned

## Summary

Today, remote actions/patches can enter a client DB through **two independent ingress paths**:

- **RPC fetch**: `SyncNetworkServiceLive.fetchRemoteActions` fetches from the sync server and inserts into `action_records` / `action_modified_rows` (`packages/sync-client/src/SyncNetworkService.ts:149`).
- **Electric stream**: `ElectricSyncService` subscribes to Electric shapes and inserts into the same tables (`packages/sync-client/src/electric/ElectricSyncService.ts:185`), then triggers `SyncService.performSync()` (`packages/sync-client/src/electric/ElectricSyncService.ts:254`).

But **apply** and **cursor advancement** are currently driven by the *RPC fetch return value* inside `SyncService.performSync` (`packages/sync-core/src/SyncService.ts:266`), not by the authoritative DB state.

This creates redundant work today, and will break correctness when we evolve toward “Electric-only ingress” (or even just stop double-fetching): remote rows can be present locally yet never applied / never advance `last_seen_server_ingest_id`, causing upload rejections and ambiguous behavior.

This doc proposes making the client’s local DB (`action_records` + `local_applied_action_ids`) the single source of truth for:

1) which remote actions exist locally, 2) which are unapplied, and 3) which ingestion cursor the client can safely claim as “seen”.

## Problem Statement

### 1) Two ingress writers → double fetch / double insert pressure

With Electric enabled, the client can ingest the same remote rows twice:

- Electric inserts them from the shape stream
- RPC fetch inserts them again on every `performSync` call

Inserts are idempotent via `ON CONFLICT DO NOTHING`, so this is “safe”, but it:

- increases load and latency
- increases complexity (harder to reason about the canonical ingress source)
- creates race windows where code paths disagree about “what remote actions exist”

### 2) `performSync` currently trusts “what fetch returned”, not “what is in the DB”

`SyncService.performSync` decides whether “remote exists”, and how far to advance `last_seen_server_ingest_id`, based on:

- `const { actions: remoteActions } = yield* syncNetworkService.fetchRemoteActions()` (`packages/sync-core/src/SyncService.ts:266`)

This is fine in “RPC-only” mode (fetch both ingests and returns the batch), but in “Electric ingress” mode the authoritative remote batch is often **already present** in local tables before `performSync` runs.

If we later make `fetchRemoteActions` a no-op under Electric (which is the natural next step to remove redundant fetch), then:

- `remoteActions` becomes empty
- `performSync` may treat the world as “no remote”
- `last_seen_server_ingest_id` may not advance (basis uploads can be rejected)
- remote rows can remain “synced but unapplied” indefinitely

### 3) We already have the missing primitive, but it’s unused

`ActionRecordRepo.findSyncedButUnapplied()` exists (`packages/sync-core/src/ActionRecordRepo.ts:135`) and expresses the right idea:

- remote rows should be “synced=true”
- “applied” is tracked separately (via `local_applied_action_ids`)
- the apply loop should process “synced but unapplied” regardless of how those rows arrived

But `SyncService.performSync` does not use it today.

## Goals / Non-goals

### Goals

- Exactly one place defines “which remote actions should be applied next”.
- Electric ingress can be enabled without requiring RPC fetch to also run.
- Cursor advancement (`last_seen_server_ingest_id`) is derived from the canonical local DB state (not transient network responses).
- Keep the existing correctness model (server head-gating via `basisServerIngestId`) and “clients are honest” assumption for now.
- Avoid a broad rewrite; prefer an incremental refactor.
- Keep Electric optional: library consumers should be able to use other transports (polling fetch, SSE/WebSocket, bespoke replication) without changing core sync logic.

### Non-goals

- RLS enforcement tests (tracked separately).
- Switching transports (we can keep both Electric and RPC).
- Defense-in-depth against malicious/buggy clients (vector-causality checks can be revisited later).

## Transport Abstraction (follow-on design)

Electric was chosen for demo convenience (real-time replication out of Postgres), but it should remain an **optional transport**. The core sync algorithm should not require Electric-specific components; it should only require that:

1. Remote `action_records` / `action_modified_rows` reliably reach the client DB.
2. The client can upload local unsynced actions/AMRs to the server.
3. The sync loop can be triggered (periodically, on demand, or by a push signal).

### What “transport” should mean in Synchrotron

Transport is the *delivery mechanism* for the sync metadata tables:

- **Remote ingress**: “bring remote action log rows + AMRs into the client DB”
  - examples: RPC polling, SSE/WebSocket stream, Electric shape replication, offline batch import
- **Local egress**: “upload unsynced local actions + AMRs to the server”
  - examples: RPC, direct Postgres connection (server-side apps), message queue

This is orthogonal to the client DB backend abstraction (`docs/planning/db-adapter-abstraction.md`): any transport should work with any supported local DB adapter.

### Proposed boundary: pluggable transport services

Today `SyncNetworkService` mixes “network” with “ingest into local tables” (`packages/sync-client/src/SyncNetworkService.ts:149`). For long-term flexibility, we should make the transport boundary explicit, so consumers can swap implementations without inheriting Electric or the RPC schema.

Two viable directions (we can choose later; Option A works with either):

1) **Split the service** (clean separation):
   - `RemoteIngressService`: fetch/stream remote rows into local DB
   - `LocalEgressService`: upload local rows to the server

2) **Keep one service but formalize its contract**:
   - rename `SyncNetworkService` → `SyncTransportService`
   - document whether its methods are responsible for inserting into the local DB or only returning payloads

Conceptually, the core should depend on “ingest happened” and “upload happened”, not on Electric or RPC directly.

### Why this doc’s Option A helps transport abstraction

Option A makes “apply” DB-driven (`findSyncedButUnapplied`), which means:

- Remote ingress can be implemented by *anything* that writes into `action_records` / `action_modified_rows` with `synced=1`.
- `SyncService.performSync` can converge even if `fetchRemoteActions()` is a no-op (Electric-only) or a polling call (RPC-only).

That is the key enabler for making Electric optional without fragmenting correctness logic.

### Consumer-facing configuration goal (future)

Expose a clean, library-consumer choice such as:

- **RPC-only** (no Electric): pull by `server_ingest_id` cursor + upload by RPC
- **Electric ingress + RPC upload**: Electric keeps the local action log up to date; RPC only uploads local unsynced actions
- **Custom transport**: consumer provides a Layer implementing the ingress/egress services

This doc does not implement that API yet; it only captures the architectural intent so we don’t bake Electric assumptions into `SyncService`.

## Proposed Solutions (Options)

### Option A (recommended): DB-driven apply + cursor; ingress just populates tables

Make the local DB the single “remote queue”:

1. “Ingress step” ensures remote `action_records`/`action_modified_rows` are present locally (via RPC fetch insert, Electric stream insert, or both).
2. `SyncService.performSync` determines remote work by querying:
   - `ActionRecordRepo.findSyncedButUnapplied()`
3. Apply/reconcile based on the DB-derived remote set.
4. Advance `last_seen_server_ingest_id` based on the DB-derived remote head that the client has actually ingested and applied.

Implementation detail: keep `SyncNetworkService.fetchRemoteActions()` for RPC ingress, but treat its return value as *optional* and not authoritative for apply decisions.

This is the minimal change that makes Electric-only ingress viable.

### Option B: Push all ingestion into `SyncService` (network returns data, does not write DB)

Change the contract of `SyncNetworkService.fetchRemoteActions()` to return `{ actions, modifiedRows }` only, and move all DB insertion to a single place in `SyncService`.

Electric ingestion would need to be refactored to not insert into tables directly (instead emit messages to `SyncService`), or to insert into a separate staging area.

This is architecturally clean but a larger refactor than we need right now.

### Option C: Choose one ingress mechanism (disable the other)

Make Electric or RPC the only remote ingress mechanism.

This is simplest operationally but reduces flexibility and doesn’t match the current architecture (Electric is already part of the client story).

## Recommendation

Proceed with **Option A**:

- It aligns with existing schema (`local_applied_action_ids`) and repo query (`findSyncedButUnapplied`).
- It preserves the current public API surface (we can refine contracts later).
- It cleanly separates concerns:
  - ingress: “make the rows exist”
  - apply: “materialize them into base tables”
  - cursor: “persist how far we’ve seen/applied”

## Concrete Design Changes (Option A)

### 1) `performSync` should query the DB for remote work

After the ingress step:

- compute `remoteUnapplied = ActionRecordRepo.findSyncedButUnapplied()`
- treat `remoteUnapplied.length > 0` as `hasRemote`

This makes Electric-ingested rows visible to the apply loop even if RPC fetch returns `[]`.

### 2) Cursor advancement should be DB-derived and tied to applied/reconciled completion

Define `last_seen_server_ingest_id` as:

> “the maximum `server_ingest_id` among other-client action_records that are present locally and whose effects have been incorporated into the client’s current state (via apply/reconcile).”

In practice:

- compute `latestSeenServerIngestId` from the DB remote set you’re about to apply (or from a DB query for remote head)
- advance it only after apply/reconcile finishes successfully

This preserves the “honest client” contract: claiming a cursor implies you have incorporated predecessors.

### 3) Electric mode should not require RPC fetch

Once DB-driven apply exists, we can make `SyncNetworkServiceLive.fetchRemoteActions` conditional:

- In Electric-enabled clients, it can become a no-op (or a cheap health check).
- RPC fetch remains for “no Electric” environments.

Note: PGlite provides an official `electric.syncShapesToTables(...)` API for syncing multiple shapes transactionally; we can consider replacing the custom `TransactionalMultiShapeStream` ingestion later, but it’s not required for this change.

## Implementation Plan

1. **Refactor `SyncService.performSync` remote detection**:
   - call `syncNetworkService.fetchRemoteActions()` as an ingress step (keep behavior for RPC mode)
   - compute `remoteActions` from `ActionRecordRepo.findSyncedButUnapplied()` instead of the fetch return value
2. **Add a helper to compute “remote head ingest id” from the DB** (excluding local client id):
   - use it to advance `last_seen_server_ingest_id` after apply/reconcile
3. **Adjust Electric integration**:
   - ensure `ElectricSyncService` continues to trigger `performSync()` when up-to-date
   - (later) add a config switch so RPC fetch is disabled in Electric mode
4. **Update docs**:
   - `DESIGN.md`: define “remote ingress vs apply vs cursor” responsibilities
   - `README.md`: describe recommended deployment modes (RPC-only vs Electric-ingress)

## Testing Plan

Add a regression test that proves DB-driven apply works when fetch returns nothing:

- Arrange: insert remote action_records + action_modified_rows directly into client DB as `synced=1` (simulating Electric ingestion), but stub `fetchRemoteActions()` to return `[]`.
- Act: call `SyncService.performSync()`.
- Assert:
  - the remote actions are applied (base tables match expected state)
  - `last_seen_server_ingest_id` advances to the remote head

Follow-ups:

- “No double fetch in Electric mode”: when fetch is disabled, Electric-only still converges and uploads succeed (server head-gating satisfied).

## Open Questions

### Cursor semantics (ingested vs applied)

Today we have one persisted ingestion watermark: `client_sync_status.last_seen_server_ingest_id` (used for “fetch since” and also used as `basisServerIngestId` when uploading).

When remote ingress and remote apply are decoupled (especially under Electric), there are really two distinct moments:

1) **Ingested**: remote rows exist locally in `action_records` / `action_modified_rows` (e.g. inserted by Electric or by RPC fetch).
2) **Applied**: those ingested rows have actually been incorporated into the client’s materialized base tables via apply/reconcile (and `local_applied_action_ids` reflects that), so it’s valid to claim “I’m caught up to X” as an upload basis.

If we keep a **single cursor**, we must pick which meaning it has:

- If it means **applied**, we only advance it after apply/reconcile succeeds. This is simplest and safest: `basisServerIngestId` remains a meaningful “I incorporated everything up to here” proof (under honest clients). Downsides: after a crash between ingest and apply, the client may re-fetch already-ingested rows (safe, due to idempotent inserts), and we can’t easily see “ingest backlog” vs “apply backlog”.
- If it means **ingested**, we can advance it as soon as rows arrive, which avoids re-fetch on restart — but then it is *not* safe to reuse as `basisServerIngestId` unless we add another guard, because we’d be claiming up-to-date before reconciliation is reflected in base tables.

Splitting into **two cursors** makes this explicit:

- `last_ingested_server_ingest_id`: max remote `server_ingest_id` present locally (ingress progress; used only to avoid re-fetching / to resume streams).
- `last_applied_server_ingest_id`: max remote `server_ingest_id` whose effects are incorporated into local state (apply progress; used as `basisServerIngestId` for uploads).

This is more “provable” (and easier to debug), but it requires schema + logic changes.

Initial recommendation: keep a **single cursor with “applied” semantics** until we see real-world pressure to optimize re-fetch or to expose progress UI.

### Electric ingress completion signal

Do we want an explicit “ingress completed” signal from Electric (per-shape) before we allow upload, or is the existing “fully synced” signal sufficient?

## Related

- Server ingestion cursor: `docs/planning/todo/0002-reliable-fetch-cursor.md`
- Server materialization & head-gating: `docs/planning/todo/0007-server-materialization.md`
