# 0021 — Transport v2: `SyncIngress` service + core runner

## Status

Implemented

## Summary

We want a transport story that is easy for consumers to implement and that keeps `sync-core` decoupled
from app-specific networking details.

Today we have a good **v1** boundary:

- `SyncNetworkService` (RPC transport contract) for:
  - pulling remote sync-log rows (`fetchRemoteActions`)
  - uploading local actions/AMRs (`sendLocalActions`)
  - bootstrap snapshots (`fetchBootstrapSnapshot`)
- core-owned ingestion helper (`ingestRemoteSyncLogBatch`)
- transport-safe trigger helper (`SyncService.requestSync()`), so transports/apps can “kick” sync without
  overlapping `performSync()` runs.
- Electric mode uses `FetchRemoteActions(mode="metaOnly")` so RPC remains metadata+upload-only.

However, push/hybrid transports still need bespoke wiring (like the old `ElectricSyncService`) to:

- translate transport messages into action-log batches,
- write those batches into local sync tables,
- decide when to trigger the sync runtime,
- avoid sync storms / duplicate “single flight” logic.

This doc proposes a **standard ingress interface** (`SyncIngress`) plus a **core-owned runner** that:

1. consumes transport events (push, pull, notify-only, hybrids),
2. ingests remote sync-log rows into local tables (idempotent),
3. triggers `SyncService.requestSync()` in a coalesced way.

## Why “push vs pull” isn’t enough

“Push vs pull” is the primary axis, but real systems commonly use hybrids:

- **notify + pull**: server pushes “something changed”, client then pulls deltas.
- **push fast path + pull repair**: stream most of the time; pull on reconnect/backfill.
- **multi-source**: different channels for different audiences; or redundant ingress for safety.
- **checkpoint/bootstrap**: ingest a snapshot/log segment, then resume live ingress.

So we should model ingress as _capabilities_, not as exactly two mutually-exclusive strategies.

## Goals

- A consumer can implement a custom ingress transport without understanding sync-table SQL quirks.
- `sync-core` owns ingestion + apply/reconcile; transport code only delivers events.
- Support push, pull, notify+pull, and push+backfill with the same interface.
- Make it hard to accidentally implement “two ingress writers”.
- Keep `SyncService.performSync()` as the underlying unit of work; encourage `requestSync()` as the trigger.

## Non-goals (for this TODO)

- Implementing a brand-new transport abstraction end-to-end immediately.
- Changing the server protocol beyond what’s already needed (`FetchRemoteActions(mode)` already exists).
- Solving transport auth, reconnection, or offline UX generically (apps own that).

## Proposed API (core)

Add a new optional service in `sync-core`:

```ts
import type { ActionModifiedRow, ActionRecord } from "@synchrotron/sync-core/models"
import type { Stream } from "effect"

export type SyncIngressEvent =
	| {
			readonly _tag: "Batch"
			readonly actions: ReadonlyArray<ActionRecord>
			readonly modifiedRows: ReadonlyArray<ActionModifiedRow>
			readonly caughtUp?: boolean
	  }
	| {
			readonly _tag: "Wakeup"
			readonly caughtUp?: boolean
	  }

export interface SyncIngress {
	readonly events: Stream.Stream<SyncIngressEvent, SyncIngressError>
}
```

Notes:

- `Batch` supports push-ingress (Electric, WS, SSE-with-payload, etc).
- `Wakeup` supports notify-only transports and “poll scheduling” without making the ingress own fetching.
- `caughtUp` is optional; it’s useful for UX/debug but not required for correctness.

## Core-owned runner (`SyncIngressRunner`)

Add a small internal module/layer that:

- subscribes to `SyncIngress.events` in a scoped fiber,
- on `Batch`: calls `ingestRemoteSyncLogBatch(sql, { actions, modifiedRows })`,
- on `Wakeup` (and after a `Batch`): calls `SyncService.requestSync()`,
- relies on `requestSync()` for burst coalescing + single-flight (so the runner can be simple).

This yields a consistent behavior:

- push transports don’t need to implement ingestion or concurrency guards,
- notify+pull transports can just emit wakeups (engine still pulls via `fetchRemoteActions()`),
- pull-only apps can choose between “interval in app” vs “polling ingress emits wakeups”.

## How this fits with `SyncNetworkService`

We should keep `SyncNetworkService` for egress and for pull-based fetch (at least initially).

Patterns:

- **Pure pull (polling)**:
  - provide `SyncNetworkServiceLive` (full fetch)
  - either:
    - app schedules `syncService.requestSync()` (status quo), or
    - `SyncIngress` emits periodic `Wakeup` events, and the runner triggers `requestSync()`.
- **Pure push (data stream)**:
  - provide a `SyncIngress` that emits `Batch` events (no DB writes in transport)
  - provide `SyncNetworkService` in meta-only mode for epoch/retention + uploads:
    - `FetchRemoteActions(mode="metaOnly")`
- **Notify + pull**:
  - `SyncIngress` emits `Wakeup` when notification arrives
  - `SyncNetworkService` remains full fetch; `performSync()` will pull deltas when run.
- **Push + pull repair**:
  - `SyncIngress` emits `Batch` from the stream
  - additionally emit `Wakeup` on reconnect so `performSync()` can pull/repair if needed
  - keep `SyncNetworkService` meta-only (or full fetch if we explicitly want repair pulls).

## Implementation plan

1. ✅ Introduce `SyncIngress` service + event types in `sync-core` (default: not provided).
2. ✅ Add a core-owned runner as `runSyncIngressRunner` + `SyncIngressRunnerLive` in `sync-core`.
3. ✅ Refactor Electric ingress to provide `SyncIngress` (`ElectricSyncIngressLive`).
4. ✅ Add a sync-client `SynchrotronTransport` shape and make `makeSynchrotronClientLayer(...)` automatically enable the ingress runner when `transport.syncIngressLayer` is provided (Electric uses this).
5. ✅ Add tests:
   - `sync-core`: runner ingests batches idempotently + gates `requestSync()` on `caughtUp`
   - `sync-client`: Electric emits ingress events; runner triggers sync only once both shapes are up-to-date

## Open questions

1. Should `SyncIngress` support multiple sources (e.g. `Layer.mergeAll(...)`) and have the runner
   de-duplicate by action id (or just rely on ingestion idempotence)?
2. Should we split `SyncNetworkService` into two explicit services (egress vs pull-ingress vs meta),
   or keep it as-is for now?
3. Should the runner surface “caught up” state as a service for UX (eg `SyncStatus`)?

## Notes / guardrails

- The runner (`runSyncIngressRunner`) calls `ClientDbAdapter.initializeSyncSchema` before consuming events, so transport code can safely start early.
- `caughtUp` is optional. The runner triggers `SyncService.requestSync()` on every `Batch` by default; setting `caughtUp: false` opts out (useful during initial backfill).
- Transports should not write directly to `action_records` / `action_modified_rows`. Instead:
  - provide `SyncIngress` events, and
  - pass a `transport` with `syncIngressLayer` (the client layer enables the runner automatically).
- `@synchrotron/sync-client/transports/ElectricTransport` is the reference implementation for a push-ingress transport (`SyncIngress` + RPC meta-only fetch).
