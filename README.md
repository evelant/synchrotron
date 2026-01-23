# Synchrotron

Offline-first sync for Postgres that converges by replaying business logic.

Synchrotron records deterministic _actions_ (your application business logic functions that mutate data) and syncs those, rather than treating row-level patches as the primary source of truth. When clients diverge, they roll back to a common ancestor and replay actions in a global order. This keeps business rules in one place and avoids writing bespoke conflict-resolution handlers.

It is designed to work with private data (Postgres RLS): actions can be conditional on private rows and still converge (per-user view) by emitting SYNC deltas when replay produces different results.

It also depends on a few simple but hard requirements (see Usage). They're not optional.

Built with [Effect](https://effect.website/) and `@effect/sql`. The demo transport uses [Electric SQL](https://electric-sql.com/) to replicate the sync metadata tables in real time, but the transport is intentionally pluggable (polling fetch, WebSocket/SSE, bespoke backends, etc).
The reference client DB is [PGlite](https://pglite.dev/) (Postgres-in-WASM), and the client runtime also supports SQLite (WASM + React Native) via a small `ClientDbAdapter` interface.

## Why actions?

Most offline sync stacks replicate table changes and settle concurrency with last-write-wins (or similar naive strategy). That converges, but it ignores semantic intent: two "valid" patches can still violate business rules, and you end up writing merge/conflict handlers on top.

Synchrotron moves the merge boundary up a level:

- You sync operations (actions), not just their resulting patches
- Conflicts resolve by rollback + replay of the same business logic
- Patches are still captured, but only for fast-forwarding, rollback, and divergence detection

## Status

### Experimental

- This is an experimental project and is not ready for production use
- There are comprehensive tests in `packages/sync-core` illustrating that the idea works
- API is split into packages: `sync-client`, `sync-core`, and `sync-server`
- There are example apps demonstrating basic functionality:
  - **Shared backend**: `examples/backend` (Postgres + Electric + Bun RPC server).
    - `pnpm docker:up` (requires Docker)
    - `pnpm dev:backend` (starts docker + server)
  - **Web + PGlite**: `examples/todo-app-web-pglite` (Bun build --watch + Bun static server; works online/offline; does not yet handle multiple tabs in the same window).
    - Includes a built-in “two clients” harness (Client A / Client B) with transport toggle (RPC polling vs Electric ingress) and a per-client debug panel.
    - `pnpm dev:web`
    - Open http://localhost:5173 in your browser
  - **React Native + SQLite (+ Web)**: `examples/todo-app-react-native-sqlite` (native uses `@effect/sql-sqlite-react-native` backed by `@op-engineering/op-sqlite`; web uses `@effect/sql-sqlite-wasm` via a `.web.ts` module).
    - `pnpm dev:react-native`

## Capabilities

- **Full offline SQL**: Actions can read/write the local database without CRDT-style restrictions
- **Intent preservation**: Invariants live in your actions and are re-applied during replay
- **No dedicated conflict-resolution code**: No per-field merge functions; resolution is "re-run the logic"
- **RLS-friendly**: PostgreSQL Row Level Security filters what each client can see; clients still converge
- **Deterministic IDs**: Actions generate stable IDs in TypeScript so clients don't fight over primary keys
- **Eventual consistency**: Converges even with private data and conditional logic (via SYNC deltas)

## Differences

- **Patch/LWW replication**: Many offline-first strategies sync row/field changes and pick a winner (explicitly or implicitly). They converge, but semantic conflicts and invariant breaks are left to app code. Synchrotron merges by rerunning the mutation logic and only uses patches as a low-level mechanism for rollback/fast-forward.
- **CRDTs**: CRDT merges work at the data-structure level (field/column). They're great when your domain fits those types (such as a text editor), but cross-row/cross-table invariants still need separate handling. Synchrotron keeps your relational model and re-applies invariants by replaying actions.
- **Event sourcing**: Event sourcing is a persistence model where domain events are the source of truth. It doesn't, by itself, solve multi-writer offline merges or partial visibility (RLS). Synchrotron is a replication/convergence strategy not a persistence model. You can still emit domain events from actions for audit/integration if you want.
- **Write-through server + offline queue**: A common pattern is to queue API requests while offline and let the server be the only authority. That works, but it usually limits what "offline" can do and pushes conflict handling to server endpoints. Synchrotron lets clients execute full local transactions and reconcile later.
- **OT / collaborative editors**: OT is usually purpose-built for documents (text) with per-type transforms. Synchrotron is built around a database and general application mutations.

## How it works (high level)

- `executeAction` runs an action in a transaction and records `{ _tag, args, client_id, clock }`
- Triggers capture per-row forward/reverse patches into `action_modified_rows`
- `action_records` and `action_modified_rows` are delivered to clients either via Electric SQL shape streams (filtered by RLS) or via an RPC transport (`SyncNetworkService`)
- Remote actions are fetched/streamed incrementally by a server-generated ingestion cursor (`server_ingest_id`) so clients don't miss late-arriving actions; replay order remains clock-based
- The server is authoritative: it materializes base tables by applying patches in canonical order (rollback+replay on late arrival) and can reject uploads from clients that are behind the server ingestion head (client must fetch+reconcile+retry; `performSync()` does a small bounded retry; RPC error `_tag` = `SendLocalActionsBehindHead`)
- Applying a remote batch re-runs the action code on the client; if replay produces _additional_ effects beyond the received patches (including any received SYNC patches), the client emits a new patch-only SYNC action at the end of the sync pass (clocked after the observed remote actions)
- If remote history interleaves with local unsynced actions, the client rolls back to the common ancestor and replays everything in HLC order

## TODO

- RLS hardening: expand policies + tests beyond the v1 demo (`packages/sync-server/test/rls-filtering.test.ts`).
- Tighten SYNC semantics + diagnostics (see `DESIGN.md`).
- Add end-to-end tests with the example app
- Add pruning/compaction for old action records to prevent unbounded growth, and use `SyncService.rebase()` for clients that are offline long enough that they would need pruned history to catch up.
- Improve the APIs. They're proof-of-concept level at the moment and could be significantly nicer.
- Consider a non-Effect facade. Effect is great, but not every codebase can adopt it; a Promise-based wrapper should be straightforward.
- Add support for multiple clients in the same window (PGlite workers)
- Add doc comments and typedoc gen
- Upstream @effect/sql-pglite (https://github.com/Effect-TS/effect/pull/4692)
- Improve docs
- Clean up logging and debug
- Improve example app, make it more real-world. Maybe add another based on [linearlite](https://github.com/electric-sql/electric/tree/main/examples/linearlite)
- Evaluate performance in a more real world use case. The example todo app seems plenty fast but performance with larger datasets is unknown and there is currently no optimization.

## Client databases

The client DB is selected by which `@effect/sql` driver layer you provide:

- **PGlite** (browser): `makeSynchrotronClientLayer(...)` from `@synchrotron/sync-client`
- **SQLite (WASM)**: `makeSynchrotronSqliteWasmClientLayer()` from `@synchrotron/sync-client`
- **SQLite (React Native / React Native Web)**: `makeSynchrotronSqliteReactNativeClientLayer(sqliteConfig, config?)` from `@synchrotron/sync-client/react-native` (native: `@effect/sql-sqlite-react-native` backed by `@op-engineering/op-sqlite`; web: `@effect/sql-sqlite-wasm` using OPFS persistence via `OpfsWorker`)

Note: this repo applies a pnpm `patchedDependencies` patch to `@effect/sql-sqlite-react-native` for `@op-engineering/op-sqlite@15.x` compatibility (see `patches/@effect__sql-sqlite-react-native.patch`).

Note: this repo applies a pnpm `patchedDependencies` patch to `@effect/sql-sqlite-wasm` to (a) provide a `locateFile` override for Metro / React Native Web wasm loading (SqliteClient + OpfsWorker), (b) fail fast on OPFS worker startup errors instead of hanging on the `ready` handshake, and (c) avoid a `connectionRef` TDZ crash if the worker errors before initialization (see `patches/@effect__sql-sqlite-wasm.patch` and `packages/sync-client/src/db/sqlite-react-native.web.ts`). The React Native example copies the `wa-sqlite.wasm` binaries into `examples/todo-app-react-native-sqlite/public/` (via `postinstall`) so web can load them from `/wa-sqlite.wasm`.

## Networking

`SyncService` depends on a `SyncNetworkService` implementation. The default client implementation is `SyncNetworkServiceLive` (HTTP RPC via `@effect/rpc`).

- Configure the RPC endpoint with `makeSynchrotronClientLayer({ syncRpcUrl: "http://..." })` or `SYNC_RPC_URL` (default: `http://localhost:3010/rpc`).
- Auth for RLS:
  - `Authorization: Bearer <jwt>` (server verifies and derives `user_id` from `sub`).
  - Client-side: set `SynchrotronClientConfig.syncRpcAuthToken` to send the bearer token (or provide a custom `SyncRpcAuthToken` layer to fetch/refresh tokens dynamically).

## Observability

Synchrotron uses Effect's built-in logging + tracing.

- `SyncService` wraps key sync phases in `Effect.withSpan(...)` and annotates logs with correlation IDs like `syncSessionId`, `applyBatchId`, and `sendBatchId`.
- `@effect/sql-pglite` logs every executed SQL statement at `TRACE` as `pglite.statement.start` / `pglite.statement.end` / `pglite.statement.error` (statement text is truncated to keep logs readable).
- The client/server RPC path logs structured `sync.network.*` / `rpc.*` events with action + patch counts (plus extra detail for `_InternalSyncApply` / SYNC deltas).

## Usage

Synchrotron only works if you follow these rules. They're simple, but they're hard requirements:

1.  **Initialize the Sync Schema:** On clients, call `ClientDbAdapter.initializeSyncSchema` (provided by either `PostgresClientDbAdapter` or `SqliteClientDbAdapter`). On the Postgres backend, run `initializeDatabaseSchema` to also install server-only SQL functions used for patch-apply / rollback.
2.  **Install Patch Capture:** Call `ClientDbAdapter.installPatchCapture([...])` during your database initialization for _all_ tables whose changes should be tracked and synchronized by the system. This installs patch-capture triggers (AFTER INSERT/UPDATE/DELETE) that write to `action_modified_rows` (dialect-specific implementation).
    - Tracked tables must include an `audience_key` column (`TEXT`). Patch capture copies `NEW/OLD.audience_key` onto `action_modified_rows.audience_key` for fast RLS filtering (shared/collaborative rows) and strips it out of the JSON patches. Prefer a generated `audience_key`; otherwise patch-apply populates it from `action_modified_rows.audience_key` on INSERT (see `docs/shared-rows.md`).
    - On SQLite, `installPatchCapture` should be called after any schema migrations that add/remove columns on tracked tables (it drops/recreates triggers from the current table schema).
    - On SQLite, declare boolean columns as `BOOLEAN` (not `INTEGER`) so patch capture can encode booleans as JSON `true/false` (portable to Postgres); `0/1` numeric patches can cause false divergence and server-side apply failures.
    - On SQLite, Synchrotron coerces bound boolean parameters (`true/false`) to `1/0` at execution time (SQLite driver limitation).
    ```typescript
    // Example during setup:
    import { ClientDbAdapter } from "@synchrotron/sync-core"
    // ... after creating tables ...
    const clientDbAdapter = yield * ClientDbAdapter
    yield * clientDbAdapter.installPatchCapture(["notes", "todos", "other_synced_table"])
    ```
3.  **Action Determinism:** Actions must be deterministic aside from database operations. Capture any non-deterministic inputs (like current time, random values, user context not in the database, network call results, etc.) as arguments passed into the action. The `timestamp` argument (`Date.now()`) is automatically provided. You have full access to the database in actions, no restrictions on reads or writes.
    - Actions are defined via `ActionRegistry.defineAction(tag, argsSchema, fn)`.
    - `argsSchema` must include `timestamp: Schema.Number`, but the returned action creator accepts `timestamp` optionally; it is injected automatically when you create an action (and preserved for replay).
    - `action_records.args` are replicated to any client that can read that `action_records` row (no redaction). Don’t put secrets in args; store private inputs in normal tables protected by RLS and pass only opaque references (ids) in args.
    - Design note: “purity” means repeatable on the same snapshot. If running an action twice against the same DB state produces different writes, that’s a determinism bug. Also treat “hidden/private state influencing writes to shared rows” as an application-level constraint: it can leak derived information, and competing SYNC overwrites on shared fields resolve via action order (last SYNC wins). See `DESIGN.md`.
4.  **Mutations via Actions:** All modifications (INSERT, UPDATE, DELETE) to synchronized tables _must_ be performed exclusively through actions executed via `SyncService` (e.g. `const sync = yield* SyncService; yield* sync.executeAction(action)`). Patch-capture triggers will reject writes when no capture context is set (unless tracking is explicitly disabled for rollback / patch-apply).
5.  **IDs are App-Provided (Required):** Inserts into synchronized tables must explicitly include `id`. Use `DeterministicId.forRow(tableName, row)` inside `SyncService`-executed actions to compute deterministic UUIDs scoped to the current action. Avoid relying on DB defaults/triggers for IDs; prefer removing `DEFAULT` clauses for `id` columns so missing IDs fail fast.
6.  **Stable Client Identity:** Synchrotron persists a per-device `clientId` in Effect’s `KeyValueStore` under the key `sync_client_id`.
    - Browser clients use `localStorage`.
    - React Native (native) uses `react-native-mmkv` via `@synchrotron/sync-client/react-native` (install `react-native-mmkv` in your app).
    - React Native (web) uses `localStorage`.
    - If the local database is cleared but the `clientId` is retained, the client bootstraps from a server snapshot of the canonical base-table state (no full action-log replay) and advances its remote fetch cursor to the snapshot head (see `docs/bootstrap.md`).
    - Recovery primitives:
      - `SyncService.hardResync()` discards local state and re-fetches a bootstrap snapshot.
      - `SyncService.rebase()` keeps pending local actions (preserving action ids for deterministic ID stability), rehydrates a fresh snapshot, then re-runs those pending actions before syncing again.
      - If the server rejects an upload as `SendLocalActionsInvalid`, the client will automatically attempt a single `rebase()` and retry once.
      - If uploads are still rejected (or rejected as `SendLocalActionsDenied`), the client quarantines all unsynced actions in `local_quarantined_actions`, suspends further uploads, but continues ingesting remote actions. Apps can inspect via `SyncService.getQuarantinedActions()` and resolve via `SyncService.discardQuarantinedActions()` (rollback + drop local unsynced work) or `SyncService.hardResync()`.
7.  **RLS User Context (Server):** To enforce Postgres RLS on both app tables and sync tables, the server must run requests under a non-bypass DB role and set the principal in the transaction (`synchrotron.user_id`, and `request.jwt.claim.sub` for Supabase `auth.uid()` compatibility). The demo RPC server derives `user_id` from verified auth (`Authorization: Bearer <jwt>`). Server-side materialization applies patches under the originating action principal (`action_records.user_id`), not the request principal.
    - Real apps should use verified auth (JWT) and have the server derive `user_id` from the token. See `docs/security.md`.
    - Note: `action_records.user_id` is the originating user (audit + `WITH CHECK`). For shared/collaborative data, sync-table visibility should be derived from `action_modified_rows.audience_key` (membership/sharing rules) rather than only the originating user. See `docs/shared-rows.md` and `docs/security.md`.
8.  **Foreign Keys (Postgres):** If you use foreign keys between synced tables, prefer `DEFERRABLE INITIALLY DEFERRED` constraints (e.g. `REFERENCES notes(id) DEFERRABLE INITIALLY DEFERRED`). Server rollback+replay materialization runs in a single SQL transaction and can temporarily violate FK ordering while rewinding/reapplying patches; deferrable FKs are still enforced at commit.

## Downsides and limitations

- Not a good fit for applications with high write volume data shared between many users. The greater the write volume and number of users writing a piece of data the more action records the system will need to sync and track. This could lead to performance issues. This algorithm is probably better suited to data that is naturally scoped to relatively smaller subsets of users. For high-write volume-broadly-shared data use a traditional through-server write strategy and electric-sql to sync changes.
- While designed to be broadly applicable and flexible it may not be a good fit for all applications. There is no one-size-fits-all for offline-first writes.
- It is deeply tied to the [Effect](https://effect.website/) library. Effect offers massive advantages over plain async TypeScript, but not everybody can adopt it.

## Design

See [DESIGN.md](DESIGN.md) for design details.

## License

MIT
