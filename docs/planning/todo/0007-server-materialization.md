# 0007 — Server Materialization (Authoritative Patch Application)

## Status

In progress (prototype implemented; RLS wiring pending)

## Summary

Synchrotron’s Postgres server is **authoritative**: the server’s base tables are the source of truth that clients replicate (via Electric) and converge toward.

The server never executes application business-logic actions. Instead it:

- stores an append-only action log (`action_records`)
- stores per-row forward/reverse patches (`action_modified_rows`)
- applies patches to materialize the canonical server state
- relies on Postgres constraints + RLS to enforce write permissions

`SyncServerService.receiveActions` now aims to be an authoritative, correctness-critical materializer:

- inserts actions + AMRs idempotently
- rejects uploads when the client is behind the server ingestion head (client must fetch + reconcile + retry)
- maintains a server “applied set” (`local_applied_action_ids`) and uses rollback+replay of patches to keep base tables aligned with canonical history, including late-arriving actions

This document defines the server-side materialization contract and a concrete implementation plan to make the server’s state correct under:

- out-of-order / late-arriving actions (older HLC, newer `server_ingest_id`)
- retries / duplicate uploads (idempotency)
- rollbacks / reconciliation artifacts (clarify semantics)
- RLS enforcement during patch application

## Problem Statement

### 1) Out-of-order arrival breaks canonical patch order

With `server_ingest_id` fetch, it is expected that a newly ingested action can have an HLC replay order key that belongs **before** actions already applied to the server’s base tables.

If the server applies patches “as they arrive”, it can temporarily (or permanently) materialize a state that does not match “apply all patches in canonical order”.

### 2) Rollback handling is underspecified and currently unsafe

The current server implementation reacts to incoming `RollbackAction` records by calling `rollback_to_action(target)`, but:

- it does not handle genesis rollback (`target_action_id = null`)
- it does not (re)apply the full suffix after rollback, so the base tables can diverge from the log unless a separate protocol ensures the rolled-back suffix is *intentionally discarded and replaced*

We need a clear contract for what `RollbackAction` means on the server (if anything) and when the server should roll back and replay.

### 3) RLS context is not wired in

The server is intended to “protect security via RLS”, meaning patch application must run in an execution context where Postgres `WITH CHECK` policies are enforced for the authenticated user/tenant.

Today, the RPC server does not establish any per-request DB role / session variables, so RLS is not actually part of the enforcement story yet.

## Goals / Non-goals

### Goals

- **Authoritative materialization:** server base tables match the defined materialization semantics for the stored log.
- **Idempotent ingest + apply:** safe retries, duplicate uploads, and partial failures.
- **Late-arrival correctness:** older-clock actions arriving later must be incorporated into the canonical materialized state.
- **No server action logic:** server stays patch-only; SYNC deltas remain patch-only actions.
- **RLS enforcement:** patch application honors application RLS policies under the authenticated context.

### Non-goals (for this doc)

- Full RLS policy specification for sync tables (`0004` tracks this).
- Proving application-level invariants server-side (server does not run action logic).
- Long-term compaction / pruning / rebase (tracked elsewhere).

## Canonical Server State (Definition)

Define the server’s canonical materialized state as the result of:

1. Taking all action records that are “in history” (see Rollback semantics below).
2. Ordering them by the canonical replay key: `(clock_time_ms, clock_counter, client_id, id)` ascending.
3. Applying the associated forward patches (`action_modified_rows`) in that order, preserving intra-action `sequence`.

Notes:

- `_InternalSyncApply` is a normal patch-carrying action and participates in the same ordering.
- `RollbackAction` has no patches; whether it participates is a semantic decision (see below).

## Proposed Server Materializer Design

### A) Track applied actions (server-side)

Introduce an explicit “server materializer state” so the server can:

- incrementally apply new actions when they arrive in canonical order
- roll back and replay a suffix when a late-arriving action inserts into the past

Implementation options (choose one):

1. **Reuse `local_applied_action_ids`** on the server as “server_applied_action_ids”.
   - Pros: already exists in schema; rollback helpers already reference it.
   - Cons: naming is misleading; must be clearly documented as dual-purpose.
2. **Create a dedicated table** `server_applied_action_ids(action_record_id primary key)` and (optionally) `server_materialization_status` (single row) that stores the last applied replay key.
   - Pros: clearer semantics.
   - Cons: schema change.

Minimum metadata needed:

- A set of applied action ids (for rollback selection).
- A “frontier” replay key representing the newest action currently materialized.

### B) Materialization algorithm

Materialization runs after ingesting a batch of `(actions, amrs)`:

1. Insert `action_records` and `action_modified_rows` idempotently.
2. Determine whether we can **fast-forward** or must **rewind + replay**:
   - Let `K_applied` be the current materializer frontier replay key.
   - Let `K_min_incoming` be the minimum replay key among newly ingested actions that have patches.
   - If `K_min_incoming > K_applied`, we can fast-forward: apply the canonical-ordered set of unapplied actions after `K_applied`.
   - Otherwise, we must rewind to a safe point and replay a suffix.
3. Rewind + replay strategy (baseline):
   - Find a rollback target `T` that is the predecessor action just before `K_min_incoming` (or genesis).
   - Roll back server base tables to `T` (reverse patches for applied actions after `T`).
   - Re-apply forward patches for *all* actions after `T` in canonical order.

This guarantees correctness (at the cost of replaying a suffix).

### C) Where rollback happens (server-internal vs protocol)

The server must roll back and replay **internally** to incorporate late-arriving actions; this should not require any special client marker.

`RollbackAction` records can still be useful in the public log, but their meaning must match the current “no re-recording” replay model.

## RollbackAction Semantics (Current Design)

`RollbackAction` is a **patch-less replay hint**:

- It records `target_action_id` (the ancestor the emitter rolled back to) and a normal replay clock.
- It does **not** discard history or replace actions; it is not a “history rewrite”.
- Replicas may use it to take the safe path (rollback+replay) even if they would otherwise try to fast-forward.
- The server may use the oldest rollback target in an ingest batch as an efficient rollback point for re-materialization.

Historical note: an earlier design tried “server-side rebase” by re-recording replayed actions as new `action_records`. This caused practical issues and was abandoned in favor of “replay existing history + optionally emit patch-only SYNC deltas”.

## Upload Gate (Server-Side)

Because the server does not execute action logic, it relies on clients to reconcile locally (rollback+replay and emit SYNC deltas) before uploading patches.

For now (assuming honest clients), the server enforces a single coarse correctness gate:

- Clients include a `basisServerIngestId` with every upload (their last seen `action_records.server_ingest_id` from remote fetch).
- The server rejects the upload if it has any action visible to that client with `server_ingest_id > basisServerIngestId` (excluding the client’s own actions).

This forces the client to fetch remote actions first, reconcile if needed, then retry upload.

Future work: add per-row patch-staleness detection (for defense-in-depth against buggy clients), likely using vector-causality.

## RLS Enforcement Plan (Server-Side)

To make “malicious client can only corrupt rows they can write” actually true:

- The DB role used by the server must **not** have `BYPASSRLS`.
- Each RPC request must set an authenticated context (role and/or `SET LOCAL` session variables) before applying patches.
- Patch application SQL functions should be `SECURITY INVOKER` so RLS `WITH CHECK` is enforced under the caller context.

This doc does not fully specify the RLS policies (see `0004`), but server patch apply must be compatible with whichever policy pattern we adopt.

## Implementation Plan

1. **Lock in RollbackAction semantics** (“patch-less replay hint”) and ensure `DESIGN.md` matches.
2. **Add server materializer state** (reuse `local_applied_action_ids` or add dedicated tables).
3. **Implement server fast-forward apply**:
   - apply unapplied actions in canonical order
   - mark them as applied in the server-applied set
4. **Implement server rewind + replay** for late-arriving actions:
   - compute rollback target `T`
   - reverse applied actions after `T`
   - replay forward patches for the suffix in canonical order
5. **Make server ingest/apply idempotent**:
   - repeated `(actions, amrs)` uploads are safe
   - applying the same AMR twice is safe (INSERT must not error)
6. **Wire in per-request auth/RLS context**:
   - add server middleware that authenticates and sets `SET LOCAL` context
   - add an integration test that proves an unauthorized patch fails under RLS
7. **Implement server head-gating** (server-side):
   - reject uploads when the client’s `basisServerIngestId` is behind the current server ingestion head (for actions visible to that client)

## Testing Plan

Add server-focused tests (can be PGlite-backed or Postgres-in-docker, depending on what is already used):

- **Late arrival reorder:** apply `update-new`, then ingest `update-old` with an older replay key, assert final state matches canonical order (new wins if it sorts after old).
- **Idempotent retry:** upload the same batch twice; state is unchanged and no errors are raised.
- **Rollback marker safety:** if RollbackAction remains in the log, prove it cannot cause server state loss under the chosen semantics.
- **Behind-head rejection:** client uploads while behind `server_ingest_id` head; reject (client must fetch+reconcile+retry).
- **RLS enforcement:** attempt to apply a patch that violates `WITH CHECK`; assert rejection and no partial materialization.

## Related

- Fetch cursor / late arrival: `docs/planning/todo/0002-reliable-fetch-cursor.md`
- SYNC delta semantics (stabilization + overwrite cases): `docs/planning/todo/0003-sync-action-semantics.md`
- RLS policies & visibility: `docs/planning/todo/0004-rls-policies.md`
- Sort key definition: `docs/planning/todo/0001-rework-sort-key.md`
- Audit notes motivating this doc: `docs/planning/sync-design-implementation-audit.md`

## Open Questions

- Should the server ever emit rollback markers to clients as a “re-materialization hint” (server-driven), or are client-emitted markers sufficient?
- Where should materializer state live (reuse existing tables vs new server-only tables)?
- Do we want per-row patch-staleness checks later (vector-causality) for defense-in-depth against buggy clients?
- What is the minimal observability we want for the materializer (e.g. last replay key, last rollback target, rebuild counters)?
