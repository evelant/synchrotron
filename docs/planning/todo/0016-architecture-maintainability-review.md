# 0016 — Architecture + maintainability review (Effect services/layers)

## Status

Implemented (clock/identity split; explicit client modes; SyncService + SyncServerService decomposition; multi-tab deferred)

This doc started as a review; the clock/identity boundary cleanup described below is now implemented.

## Implemented changes (high level)

- Removed the old `ClockService` and split responsibilities into:
  - **Pure** HLC + ordering utilities in `sync-core` (`HLC.ts`, `ClockOrder.ts`).
  - **Client** identity + persisted clock/cursor state:
    - `ClientIdentity` Tag in `sync-core`, implemented in `sync-client` (KeyValueStore-backed `sync_client_id`).
    - `ClientClockState` in `sync-core` (DB-backed `client_sync_status`).
  - **Server** meta/clock state:
    - `ServerMetaService` in `sync-server` (derives `server_epoch` from `sync_server_meta` and `serverClock` from `action_records`).
- Made client “modes” explicit and removed accidental double-ingress:
  - `makeSynchrotronClientLayer`: RPC-only.
  - `makeSynchrotronElectricClientLayer`: Electric ingress + RPC upload/metadata (no redundant RPC action-log ingestion).
  - `SyncNetworkServiceElectricLive`: `fetchRemoteActions()` becomes metadata-only (epoch + retention watermark).
- Moved client-only config into `sync-client` (`packages/sync-client/src/config.ts`) so `sync-core` stays focused on algorithm + DB contract.
- Centralized core-owned remote ingestion:
  - `sync-core` owns a single ingestion helper (`ingestRemoteSyncLogBatch`) for persisting remote batches into `action_records` / `action_modified_rows`.
  - RPC polling is fetch-only; `SyncService.performSync()` ingests the returned rows before applying.
  - Electric ingress also uses the same ingestion helper (no duplicated table-write SQL).

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
  - Core algorithm + storage model: action log (`action_records`) + row patches (`action_modified_rows`) + rollback/replay + CORRECTION deltas
  - DB schema + patch capture triggers (`packages/sync-core/src/db/*`)
  - Repositories (`ActionRecordRepo`, `ActionModifiedRowRepo`)
  - Core runtime orchestrator (`SyncService`)
  - Dialect adapter boundary (`ClientDbAdapter` + Postgres/SQLite implementations)
  - RPC schemas (`SyncNetworkRpc`)
- `packages/sync-client`
  - Client DB connection layers (PGlite, SQLite wasm, SQLite RN)
  - RPC transport implementation (`SyncNetworkServiceLive`, `SyncNetworkServiceElectricLive`)
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
- reconciliation (rollback + replay) + CORRECTION delta emission
- recovery policies (hard resync, rebase, quarantine)

This works, but it was hard to read, test, and evolve because responsibilities were interleaved inside one large service constructor.

This has since been addressed: `SyncService.ts` is now primarily wiring, and the logic lives in internal modules under `packages/sync-core/src/sync/`:

- `SyncServiceBootstrap.ts` (bootstrap snapshot apply helpers)
- `SyncServiceExecuteAction.ts` (local action execution)
- `SyncServiceRollback.ts` (rollback + common-ancestor discovery)
- `SyncServiceApply.ts` (apply pipeline + CORRECTION delta handling)
- `SyncServiceUpload.ts` (upload pipeline)
- `SyncServiceQuarantine.ts` (quarantine + discard flow)
- `SyncServiceRecovery.ts` (hard resync + rebase)
- `SyncServicePerformSync.ts` (performSync orchestration)

Error types are centralized in `packages/sync-core/src/SyncServiceErrors.ts`.

### 2) `SyncServerService` is also a monolith (and mixes client concerns)

File: `packages/sync-server/src/SyncServerService.ts`

Previously, it owned:

- fetch protocol semantics (`getActionsSince`)
- ingest semantics (`receiveActions`)
- server materialization details (rollback/replay of patches)
- retention/compaction background process
- bootstrap snapshot generation

Previously, it used the client-oriented `ClockService` to compute `serverClock` (KeyValueStore-backed `clientId`, `client_sync_status` management). This was a boundary smell: server clock should be derived from `action_records` (or stored in `sync_server_meta`), not a “client sync status” row created by the server runtime.
This has since been addressed: the server derives `serverEpoch` / `serverClock` via `ServerMetaService` (no KeyValueStore, no `client_sync_status`).

It has also been mechanically decomposed for maintainability:

- `packages/sync-server/src/SyncServerService.ts` is now primarily wiring.
- Internal modules live under `packages/sync-server/src/server/`:
  - `SyncServerCompaction.ts` (retention/compaction helpers)
  - `SyncServerFetch.ts` (getActionsSince)
  - `SyncServerReceiveActions.ts` (receiveActions + server materialization loop)
  - `SyncServerSnapshot.ts` (bootstrap snapshot)
- Error/types are centralized and re-exported:
  - `packages/sync-server/src/SyncServerServiceErrors.ts`
  - `packages/sync-server/src/SyncServerServiceTypes.ts`

### 3) Core vs client boundary is blurred by configuration and platform services

Files:

- `packages/sync-core/src/config.ts`
- `packages/sync-core/src/ClientIdentity.ts` (Tag only; implementation lives in `sync-client`)
- `packages/sync-core/src/ClientClockState.ts`
- `packages/sync-client/src/ClientIdentity.ts` (KeyValueStore-backed implementation)

`SynchrotronClientConfig` now lives in `sync-client` (it is client-specific: PGlite config, Electric URL, RPC URL/token). Previously it lived in `sync-core`, which blurred the package boundary and made “core” feel less pure.
The `ClockService` part is now resolved via `ClientIdentity` + `ClientClockState` and server-side `ServerMetaService`.

This makes it harder to reason about what “sync-core” is supposed to be: pure algorithm + DB adapter boundary vs app runtime for specific platforms.

### 4) Transport vs ingestion vs apply is not a crisp contract

Files:

- `packages/sync-core/src/SyncNetworkService.ts` (service definition + placeholder behavior)
- `packages/sync-core/src/SyncLogIngest.ts` (core-owned ingestion helper for sync tables)
- `packages/sync-client/src/SyncNetworkService.ts` (RPC client: fetch remote batches + upload; fetch is DB-write-free)
- `packages/sync-client/src/electric/ElectricSyncService.ts` (Electric shape delivery + triggers `performSync()`; uses core ingestion helper)

Today, `SyncService.performSync()` is “DB-driven” for apply (it reads `action_records` / `action_modified_rows`). It still calls `SyncNetworkService.fetchRemoteActions()` unconditionally because it also provides server metadata (epoch + retention watermark); in RPC polling mode it also returns remote rows.

Key improvement: ingestion is now centralized.

Transports no longer implement sync-table insertion/upsert logic (and therefore don’t need to know DB-specific JSON binding rules). Both RPC polling and Electric ingress go through the same ingestion helper (`ingestRemoteSyncLogBatch`).

Remaining coupling / future refinement:

- `SyncNetworkService` still bundles “remote fetch + server meta + upload” into one service.
- Electric triggers sync on push signals, but `performSync()` still does a fetch (metadata-only in Electric mode).
- We may eventually split “server meta fetch” from “remote ingress delivery” (ingress stream / wakeups), while keeping upload RPC-only.

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

1. (Done) Move client-only config out of `sync-core`:
   - `SynchrotronClientConfig` + helpers now live in `packages/sync-client/src/config.ts`.
   - Keep `sync-core` focused on algorithm + DB contract + shared schemas.
2. Split clock/identity responsibilities:
   - Keep **pure** HLC logic (`HLC.ts`) in `sync-core` as plain functions (merge/order/etc). This is the truly shared part and does not need to be a service.
   - Implemented: split the old stateful clock responsibilities into narrower services with separate Tags:
     - Client: `ClientIdentity` (KeyValueStore-backed `clientId`) + `ClientClockState` (persists `current_clock`, `last_synced_clock`, `server_epoch`, `last_seen_server_ingest_id` in `client_sync_status`).
     - Server: `ServerMetaService` derives `serverEpoch` from `sync_server_meta` and derives `serverClock` from `action_records` — no KeyValueStore, no `client_sync_status`.
   - Effect makes it easy to substitute implementations, but a single “unified” `ClockService` interface only helps if the interface is meaningful in both runtimes. If half the methods would be server no-ops (or would force the server to maintain client-like state), prefer separate interfaces instead of pretending there’s one service.

### B) Make the ingress/apply boundary explicit

Upload transport is not intended to be pluggable: uploads stay RPC (`sendLocalActions`).

Option 1 (preferred): define a narrow _ingress-only_ contract (e.g. `SyncIngress` with a `Stream<RemoteBatch>`), then keep ingestion + apply DB-driven in `sync-core`.

Option 2: keep `SyncNetworkService.fetchRemoteActions()` as “server meta + optional remote batch delivery”, with:

- Electric mode: metadata-only (epoch + retention watermark)
- RPC-only mode: returns remote batches
- `sync-core` owning ingestion (`ingestRemoteSyncLogBatch`) so transports never implement sync-table writes

Either way, avoid having transport implementations perform table-write logic; keep DB/JSON quirks in core.

### C) Decompose the big services into focused modules

Split `SyncService` into internal modules/services with narrower APIs:

- snapshot bootstrap logic
- remote apply pipeline (idempotency + patch completeness gate)
- reconcile engine (rollback + replay + CORRECTION delta emission)
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

1. (Done) Make client “modes” explicit:
   - `makeSynchrotronClientLayer` (“RPC-only”)
   - `makeSynchrotronElectricClientLayer` (“Electric ingress + RPC upload/metadata”)
   - (Planned) “offline-only” layer constructor
2. (Done) Enforce a single remote ingress owner:
   - Electric mode uses `SyncNetworkServiceElectricLive` so RPC fetch is metadata-only (no redundant action-log ingestion).
3. (Done) Centralize remote sync-log ingestion in `sync-core` (`ingestRemoteSyncLogBatch`):
   - RPC polling is fetch-only; `SyncService.performSync()` ingests the fetched batch.
   - Electric ingress uses the same ingestion helper (no duplicated SQL).
4. (Done) Extracted “server clock” into `ServerMetaService`.
5. (Done) Break `SyncService` and `SyncServerService` into internal modules (mechanical refactor).
6. (Done) Run formatting (Prettier) on the split modules to reduce diff noise.
