# 0013 — Transport abstraction (pluggable remote ingress + local egress)

## Status

Proposed

## Summary

Synchrotron’s correctness model is DB-driven:

- Remote history lives in local `action_records` / `action_modified_rows`.
- Materialization/apply runs off `findSyncedButUnapplied()` (not off transient network responses).
- Upload is head-gated by `basisServerIngestId`.

Electric was chosen for demo convenience (realtime replication out of Postgres), but it must remain optional. We should define a small **transport interface** so consumers can plug in alternative delivery mechanisms (polling, SSE/WebSocket, Supabase Realtime, bespoke replication) without rewriting sync logic.

## Problem

Today, “transport” is not a clean boundary:

- RPC polling lives in `SyncNetworkService` and is coupled to HTTP-RPC details.
- RPC fetch implementations may also **write into the local DB** (insertion/upserts), which forces transport implementers to understand internal tables.
- Electric ingress is a separate service that also writes to the same tables and triggers sync.

This makes it hard to:

- swap transports cleanly
- reason about “one ingress pipeline”
- add new transports without copying a lot of internal wiring

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

## Proposed direction: “stream-first transport” + core-owned ingestion

### Key idea

Transport should be responsible for _delivering_ remote sync-log rows, not _writing_ them into the local DB.

Core should own exactly one ingestion function that persists remote batches into:

- `action_records` (upsert / idempotent)
- `action_modified_rows` (insert / idempotent)

This avoids duplicating “how to write sync tables correctly” across transports.

### Interface sketch

The core algorithm needs two capabilities:

1. Remote ingress (receive remote history rows).
2. Local egress (upload local rows to the server).

```ts
import type { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"
import type { Effect, Stream } from "effect"

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

export interface SendLocalActionsRequest {
	readonly clientId: string
	readonly basisServerIngestId: number
	readonly actions: ReadonlyArray<ActionRecord>
	readonly amrs: ReadonlyArray<ActionModifiedRow>
}

export interface SendLocalActionsResponse {
	readonly ok: true
}

export type SyncTransportError = {
	readonly _tag: "TransportError"
	readonly message: string
	readonly cause?: unknown
}

export interface SyncTransport {
	/**
	 * A stream of remote batches.
	 *
	 * - Polling implementations can use `Stream.repeatEffectWithSchedule(...)`.
	 * - Push implementations can use `Stream.asyncScoped(...)`.
	 * - Duplicates are allowed; ingestion is idempotent.
	 */
	readonly remoteBatches: Stream.Stream<RemoteBatch, SyncTransportError>

	/**
	 * Upload local unsynced actions/AMRs.
	 * Must enforce server head-gating via `basisServerIngestId`.
	 */
	readonly sendLocalActions: (
		req: SendLocalActionsRequest
	) => Effect.Effect<SendLocalActionsResponse, SyncTransportError>
}
```

Notes:

- `remoteBatches` is intentionally agnostic to “poll vs push”.
- We keep `basisServerIngestId` as part of the contract (it is central to correctness in the current model).
- Cursoring for `remoteBatches` can be internal to the transport (e.g. it can read `client_sync_status.last_seen_server_ingest_id` via a small helper), or we can later split the interface into:
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
- refuse to apply remote actions until their patches are present (prevents spurious SYNC deltas)
- advance `last_seen_server_ingest_id` only after apply/reconcile succeeds

So the transport does not need to be “perfectly ordered” or “transactional”, only reliable enough to eventually deliver the rows.

## Mapping existing implementations

### RPC polling (no Electric)

- `remoteBatches`: `Stream.repeatEffectWithSchedule(fetchOnce, Schedule.fixed("..."))`
  - `fetchOnce` calls the RPC endpoint (cursor-based) and returns `{ actions, modifiedRows }`.
- `sendLocalActions`: existing RPC `SendLocalActions` call.

### Electric ingress + RPC upload (current demo model)

- `remoteBatches`: wrap `TransactionalMultiShapeStream` and emit a `RemoteBatch` when both shapes have advanced (and optionally when `headers.last === true` to set `caughtUp`).
- `sendLocalActions`: still RPC (Electric is ingress-only for sync metadata tables).

This composition suggests we may want a small `SyncTransport` “combiner” later (e.g. `{ remoteBatches }` from Electric + `{ sendLocalActions }` from RPC).

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

## Follow-ups

- Decide the v1 transport contract shape:
  - stream-first (`remoteBatches`) vs pull-first (`fetchRemoteActions`) + library runner
- Move remote ingestion into core (single `ingestRemoteBatch`), and make transports return data only.
- Refactor:
  - RPC transport to implement `SyncTransport`
  - Electric transport to implement `SyncTransport` (or a composable partial)
- Update examples to depend only on the transport interface (not on Electric/RPC internals).
