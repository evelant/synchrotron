# 0016 — Architecture + maintainability review (Effect services/layers)

## Status

Implemented (clock/identity split; multi-tab deferred)

This doc started as a review; the clock/identity boundary cleanup described below is now implemented.

## Implemented changes (high level)

- Removed the old `ClockService` and split responsibilities into:
  - **Pure** HLC + ordering utilities in `sync-core` (`HLC.ts`, `ClockOrder.ts`).
  - **Client** identity + persisted clock/cursor state:
    - `ClientIdentity` Tag in `sync-core`, implemented in `sync-client` (KeyValueStore-backed `sync_client_id`).
    - `ClientClockState` in `sync-core` (DB-backed `client_sync_status`).
  - **Server** meta/clock state:
    - `ServerMetaService` in `sync-server` (derives `server_epoch` from `sync_server_meta` and `serverClock` from `action_records`).

## Goal

Improve maintainability and understandability by clarifying package boundaries, tightening service/layer composition, and separating concerns (transport vs ingestion vs apply vs upload) without changing core semantics.

## What I reviewed

- Public docs: `README.md`, `DESIGN.md`, `docs/*.md`
- Planning docs: `docs/planning/sync-design-implementation-audit.md` and related TODOs (notably `0013`, `0008`)
- Code: `packages/sync-core`, `packages/sync-client`, `packages/sync-server`, `packages/sql-pglite`, and example apps
- Effect docs (Context7): services + layers + composition (`Effect.Service`, `Layer.*`)
- PGlite docs (Context7): persistence + multi-tab worker patterns

## Architecture at a glance

- `packages/sync-core`
  - Core algorithm + storage model: action log (`action_records`) + row patches (`action_modified_rows`) + rollback/replay + SYNC deltas
  - DB schema + patch capture triggers (`packages/sync-core/src/db/*`)
  - Repositories (`ActionRecordRepo`, `ActionModifiedRowRepo`)
  - Core runtime orchestrator (`SyncService`)
  - Dialect adapter boundary (`ClientDbAdapter` + Postgres/SQLite implementations)
  - RPC schemas (`SyncNetworkRpc`)
- `packages/sync-client`
  - Client DB connection layers (PGlite, SQLite wasm, SQLite RN)
  - RPC transport implementation (`SyncNetworkServiceLive`)
  - Optional Electric ingestion (`ElectricSyncService`)
  - Platform KeyValueStore wiring (localStorage / mmkv)
- `packages/sync-server`
  - RPC handlers (`rpcRouter.ts`)
  - Auth (`SyncAuthService`)
  - Server-side fetch/ingest/materialize/snapshot/compaction (`SyncServerService`)
- `packages/sql-pglite`
  - Effect SQL driver for PGlite (logging, wasm preload, connection wrapper)

## Effect docs takeaways (services + layers)

References:

- Services/Layers: https://effect.website/docs/requirements-management/layers/
- Layer memoization: https://effect.website/docs/requirements-management/layer-memoization/

Key points that matter for this repo:

- `Effect.Service` is the “one-step” way to define a service _and_ its default `Layer` (`sync`, `effect`, `scoped` constructors; optional `dependencies` auto-wiring).
- Layer composition is easier to read when you build named “bundles” via `Layer.merge` / `Layer.mergeAll(...)`, then `Layer.provide(...)` them to a top-level layer/program.
- Layer memoization matters: shared layers are allocated once unless made `Layer.fresh`. Tests and multi-client simulations should be deliberate about sharing vs isolating instances.

## PGlite docs takeaways (persistence + multi-tab)

References:

- Filesystems (`idb://...`): https://pglite.dev/docs/docs/filesystems
- Multi-tab worker: https://pglite.dev/docs/docs/multi-tab-worker

Key points that matter for this repo:

- PGlite is effectively “single connection”, so multi-tab/multi-writer needs an explicit strategy.
- PGlite’s multi-tab worker approach uses leader election: one tab runs PGlite; other tabs proxy queries to it; when the leader closes, a new leader is elected and a new PGlite instance starts.

## Maintainability findings (concrete pain points)

### 1) `SyncService` is a monolith

File: `packages/sync-core/src/SyncService.ts`

It currently owns:

- local action execution + patch capture context
- remote ingress coordination (including snapshot bootstrap policy)
- apply pipeline (idempotency, patch completeness checks)
- reconciliation (rollback + replay) + SYNC delta emission
- recovery policies (hard resync, rebase, quarantine)

This works, but it’s hard to read, test, and evolve because responsibilities are interleaved inside one large service constructor.

### 2) `SyncServerService` is also a monolith (and mixes client concerns)

File: `packages/sync-server/src/SyncServerService.ts`

It currently owns:

- fetch protocol semantics (`getActionsSince`)
- ingest semantics (`receiveActions`)
- server materialization details (rollback/replay of patches)
- retention/compaction background process
- bootstrap snapshot generation

Previously, it used the client-oriented `ClockService` to compute `serverClock` (KeyValueStore-backed `clientId`, `client_sync_status` management). This was a boundary smell: server clock should be derived from `action_records` (or stored in `sync_server_meta`), not a “client sync status” row created by the server runtime.
This has since been addressed: the server derives `serverEpoch` / `serverClock` via `ServerMetaService` (no KeyValueStore, no `client_sync_status`).

### 3) Core vs client boundary is blurred by configuration and platform services

Files:

- `packages/sync-core/src/config.ts`
- `packages/sync-core/src/ClientIdentity.ts` (Tag only; implementation lives in `sync-client`)
- `packages/sync-core/src/ClientClockState.ts`
- `packages/sync-client/src/ClientIdentity.ts` (KeyValueStore-backed implementation)

`SynchrotronClientConfig` lives in `sync-core` but is client-specific (PGlite config, Electric URL, RPC URL/token). Previously, `ClockService` also depended on `@effect/platform` KeyValueStore (device identity storage), which is inherently “client runtime” and awkward for server usage.
The `ClockService` part is now resolved via `ClientIdentity` + `ClientClockState` and server-side `ServerMetaService`.

This makes it harder to reason about what “sync-core” is supposed to be: pure algorithm + DB adapter boundary vs app runtime for specific platforms.

### 4) Transport vs ingestion vs apply is not a crisp contract

Files:

- `packages/sync-core/src/SyncNetworkService.ts` (service definition + placeholder behavior)
- `packages/sync-client/src/SyncNetworkService.ts` (RPC client + _DB insertion_ of remote actions/AMRs)
- `packages/sync-client/src/electric/ElectricSyncService.ts` (stream ingest + DB insertion + triggers `performSync()`)

Today, `SyncService.performSync()` is “DB-driven” for apply (it reads `action_records` / `action_modified_rows`), but it still calls `SyncNetworkService.fetchRemoteActions()` unconditionally.

This becomes tricky when Electric ingestion is enabled:

- Electric already ingests into the same tables and triggers `performSync()`.
- RPC fetch also ingests into the same tables.

This can create duplicate-ingress pressure and unclear ownership of “who advanced which cursor” (already called out in `docs/planning/sync-design-implementation-audit.md`, section J).

### 5) Layer composition style is hard to scan and inconsistent

Files:

- `packages/sync-client/src/layer.ts`
- `packages/sync-client/src/react-native.ts`
- `packages/sync-server/src/rpcRouter.ts`

Common issues:

- Long `Layer.provideMerge(...)` chains are hard to audit for order/coverage.
- Some layers provided concrete dependencies internally (e.g. `KeyValueStore.layerMemory` inside `rpcRouter.ts`), reducing configurability at the app edge. (Fixed: `rpcRouter.ts` no longer bakes in a KeyValueStore.)
- `Effect.Service` `dependencies` are sometimes used and sometimes bypassed with manual provisioning, which can lead to duplication and confusion about the “canonical” wiring style.

### 6) Readability suffers from formatting drift

Several files show inconsistent indentation/bracing, making it harder to quickly understand control flow (notably `ActionModifiedRowRepo.ts`, `SyncNetworkService.ts` in client/server).

## Refactor recommendations (prioritized, no semantics change)

### A) Clarify “what lives where” (package boundary cleanup)

1. Move client-only config out of `sync-core`:
   - `SynchrotronClientConfig` + env parsing belongs in `packages/sync-client` (or per-platform entrypoints).
   - Keep `sync-core` focused on algorithm + DB contract + shared schemas.
2. Split clock/identity responsibilities:
   - Keep **pure** HLC logic (`HLC.ts`) in `sync-core` as plain functions (merge/order/etc). This is the truly shared part and does not need to be a service.
   - Implemented: split the old stateful clock responsibilities into narrower services with separate Tags:
     - Client: `ClientIdentity` (KeyValueStore-backed `clientId`) + `ClientClockState` (persists `current_clock`, `last_synced_clock`, `server_epoch`, `last_seen_server_ingest_id` in `client_sync_status`).
     - Server: `ServerMetaService` derives `serverEpoch` from `sync_server_meta` and derives `serverClock` from `action_records` — no KeyValueStore, no `client_sync_status`.
   - Effect makes it easy to substitute implementations, but a single “unified” `ClockService` interface only helps if the interface is meaningful in both runtimes. If half the methods would be server no-ops (or would force the server to maintain client-like state), prefer separate interfaces instead of pretending there’s one service.

### B) Make the transport/ingress/apply boundary explicit

Option 1 (preferred): split into two services:

- `SyncIngressService`: “get remote data into local tables” (RPC fetch _or_ Electric stream); no upload.
- `SyncUploadService`: “send local actions + AMRs”; no fetch.

Then `SyncService.performSync()` can:

- (optional) call ingress (depending on wiring),
- apply everything that is `synced=1 AND not locally applied`,
- upload pending local actions (if enabled).

Option 2: keep `SyncNetworkService`, but formalize `fetchRemoteActions()` as _optional/no-op_ in Electric mode (and document that the authoritative apply queue is DB-backed).

Either way, make it impossible to accidentally enable two competing ingress mechanisms without an explicit opt-in layer.

### C) Decompose the big services into focused modules

Split `SyncService` into internal modules/services with narrower APIs:

- snapshot bootstrap logic
- remote apply pipeline (idempotency + patch completeness gate)
- reconcile engine (rollback + replay + SYNC delta emission)
- local upload pipeline (+ quarantine policy)

Split `SyncServerService` similarly:

- fetch (RLS-filtered)
- ingest (RLS-checked)
- materializer (internal bypass + per-action principal apply)
- snapshot generator
- retention/compaction

Even if these remain “internal-only” modules, the split improves navigability and makes testing more granular.

### D) Normalize layer composition and service definitions

1. Prefer named layer bundles built via `Layer.mergeAll(...)`, then `Layer.provide(...)` once at the top.
2. Decide one consistent rule for `Effect.Service.dependencies`:
   - Either: use it to auto-wire “default” dependencies (and stop manually providing those defaults elsewhere),
   - Or: keep service layers dependency-free and wire everything explicitly at the app edge.
3. Avoid providing concrete implementations inside mid-level layers (e.g., don’t bake `KeyValueStore.layerMemory` into the RPC router layer). (Done for `rpcRouter.ts`.)

### E) Multi-tab plan for web clients (PGlite + clock safety)

If “multi-tab” is a desired capability, base the plan on PGlite’s multi-tab worker design:

- one “leader” tab owns the PGlite instance and serializes all writes
- follower tabs proxy queries to the leader

Synchrotron also needs a coherent policy for:

- `clientId` sharing across tabs (same device identity vs per-tab identity)
- clock increment serialization (avoid same-client HLC races)
- per-connection patch-capture guarantees (SQLite triggers are per-connection; PGlite is single connection but multi-tab proxies still need a single patch-capture context)

## Suggested next steps (small → large)

1. Write down the intended layering story for clients:
   - “RPC-only”, “Electric ingress + RPC upload”, “offline-only” modes as explicit layer constructors.
2. Pick a single ownership model for remote ingress, and enforce it at wiring time.
3. (Done) Extracted “server clock” into `ServerMetaService`.
4. Break `SyncService` and `SyncServerService` into internal modules (mechanical refactor).
5. Run formatting (Prettier) on the key runtime files once the mechanical splits land to reduce diff noise.
