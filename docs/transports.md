# Transports (ingress + egress)

Synchrotron’s correctness model is **DB-driven**: remote history lives in the local sync tables
(`action_records`, `action_modified_rows`) and apply/reconcile reads from the DB, not directly from transient
network responses.

This doc describes the boundaries that let you swap ingress mechanisms (polling, Electric, SSE/WS, etc)
without rewriting sync logic.

## The pieces

### `SyncNetworkService` (RPC transport)

The core sync loop (`SyncService.performSync`) depends on `SyncNetworkService` for:

- uploads: `sendLocalActions` (always RPC by design)
- pull-ingress: `fetchRemoteActions` (RPC polling mode)
- bootstrap: `fetchBootstrapSnapshot`
- server metadata: `serverEpoch`, `minRetainedServerIngestId`

Electric-enabled clients still use RPC for uploads + server metadata, but set fetch mode to `metaOnly`
so they don’t accidentally implement “two ingress writers”.

### `SyncIngress` (optional push/notify ingress)

`SyncIngress` is an optional service in `sync-core` that exposes a stream of ingress events:

- `{ _tag: "Batch", actions, modifiedRows, caughtUp? }` — push payloads
- `{ _tag: "Wakeup", caughtUp? }` — notify-only (“something changed, try syncing”)

The **core-owned ingress runner** (`runSyncIngressRunner`) is responsible for:

1. initializing sync schema,
2. ingesting `Batch` rows via the shared ingestion helper, and
3. triggering `SyncService.requestSync()` (coalesced, single-flight safe).

### `SynchrotronTransport` (sync-client convenience)

`@synchrotron/sync-client` defines a transport shape:

- `syncNetworkServiceLayer` (required)
- `syncIngressLayer` (optional)

When you pass `transport` to `makeSynchrotronClientLayer({ transport, ... })` and it includes
`syncIngressLayer`, the client layer automatically enables the core ingress runner.

See:

- `../packages/sync-client/src/transports/Transport.ts`
- `../packages/sync-client/src/layer.ts`

## Reference transport: Electric ingress

Electric is a push-ingress implementation that streams the sync metadata tables via shape replication.

- Transport bundle:
  - `../packages/sync-client/src/transports/ElectricTransport.ts`
- Ingress implementation (Electric stream → `SyncIngress.events`):
  - `../packages/sync-client/src/electric/ElectricSyncService.ts`

Behavior:

- Electric delivers `action_records` + `action_modified_rows` changes.
- The client ingests those rows and triggers sync only once both shapes are “caught up”
  (it sets `caughtUp: false` during initial backfill to avoid churn).
- RPC remains the upload path and provides server metadata.

## Implementing a custom ingress transport

Two common patterns:

### 1) Notify + pull (SSE/WS “ping”, then RPC fetch)

- Provide `SyncNetworkServiceLive` (full fetch).
- Provide a `SyncIngress` that emits `Wakeup` on notifications.
- The core runner triggers `requestSync()`, and the sync loop pulls deltas via RPC.

### 2) Push + meta-only fetch (stream actions + patches)

- Provide a `SyncIngress` that emits `Batch` events with `{ actions, modifiedRows }`.
- Provide `SyncNetworkServiceElectricLive` (meta-only fetch + uploads).

In both cases: transports do **not** write sync tables directly; they only deliver ingress events.

