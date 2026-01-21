# End-to-end tests

This repo has two types of sync tests:

- **In-process/integration** tests (mostly in `packages/sync-core/test`) which simulate the “network” by directly calling a test network service.
- **End-to-end (E2E)** tests which exercise the real HTTP/RPC transport via `fetch`, using the full `makeSynchrotronClientLayer`.

  In some sandboxed environments (including the Codex CLI / agent runner used to validate changes here), binding/listening on TCP ports is blocked (`listen EPERM` even on `127.0.0.1`). The E2E harness therefore runs the server **in-process** (no socket) and routes requests by patching `globalThis.fetch`.

## Where the E2E tests live

- `packages/sync-server/test/e2e`

They live in `sync-server` so we can stand up a real RPC server (handlers + HTTP transport) and still inspect the authoritative server database directly for assertions.

## What an E2E test sets up

### Server (in-process HTTP + RPC + DB)

The server harness is `packages/sync-server/test/e2e/harness.ts`:

- **Database**: `PGlite` (`memory://…`) via `@effect/sql-pglite`
- **Schema**: `initializeDatabaseSchema` (sync tables + server rollback/apply functions)
- **RLS**: enabled for both sync tables and the example app table (`notes`)
- **Auth**: `SyncAuthService` derives `user_id` from `Authorization: Bearer <jwt>` (`sub` → `user_id`)
- **RPC**: `SyncNetworkRpcGroup` served over HTTP using `RpcServer.toHttpApp` + `RpcSerialization.layerJson`
- **HTTP transport**: `HttpApp.toWebHandlerRuntime(runtime)` (no listening socket)

To connect clients, tests use a fixed base URL (`http://synchrotron.test`) and patch `globalThis.fetch` so any requests to that origin are routed to the in-process handler. `syncRpcUrl` is built as `http://synchrotron.test/rpc`.

If you want a “real socket” server for local development or CI environments that allow it, `packages/sync-server/test/e2e/harness.ts` still includes `makeSyncRpcServerLayer` (Node `createServer` + `NodeHttpServer`).

Note: because the harness enables RLS and `SET ROLE synchrotron_app`, any direct server-side SQL assertions must also set the RLS principal (at least `synchrotron.user_id`, and `request.jwt.claim.sub` if your policies use Supabase-style `auth.uid()` patterns) or they will see zero rows.

### Clients (real makeSynchrotronClientLayer)

Each client in an E2E test uses:

- `makeSynchrotronClientLayer({ syncRpcUrl, syncRpcAuthToken, pglite: { dataDir: "memory://…" } }, { keyValueStoreLayer: KeyValueStore.layerMemory })`
- `ClientIdOverride` to make client identities stable/deterministic in tests
- A tiny “app schema” (`notes` table) + `ClientDbAdapter.installPatchCapture(["notes"])` so actions generate AMRs.

## Running E2E tests

- All tests: `pnpm test`
- Only server package tests: `pnpm --filter @synchrotron/sync-server test`
- Only E2E tests: `pnpm --filter @synchrotron/sync-server test -- test/e2e`

## Optional: run E2E tests against a real Postgres

PGlite is close, but it’s not identical to Postgres (especially around RLS edge cases). For higher confidence, there’s an opt-in E2E suite that runs the same RPC-based tests against a real Postgres instance.

### One-command runner (recommended)

Runs Postgres (docker compose), executes the Postgres E2E suite, then tears down the containers:

- `pnpm test:e2e:postgres`

By default the runner:

- Uses a dedicated docker compose project name (`synchrotron-e2e-postgres`) so it doesn’t interfere with the example backend’s dev containers.
- Picks a free host port for Postgres (prefers `56321`, otherwise chooses an ephemeral port) and exports `E2E_DATABASE_URL` / `E2E_ADMIN_DATABASE_URL` for the Vitest run.

Useful flags:

- `pnpm test:e2e:postgres --keep-docker` (don’t stop containers)
- `pnpm test:e2e:postgres --reset-docker` (tear down with volumes)
- `pnpm test:e2e:postgres --no-docker` (assume Postgres is already running)

### Manual (if you already have Postgres running)

- Start Postgres (easy path: `pnpm --filter @synchrotron-examples/backend docker:up:postgres`)
- Run: `pnpm --filter @synchrotron/sync-server test:e2e:postgres`

Note: some sandboxed environments block Docker access entirely. In that case, run `pnpm test:e2e:postgres --no-docker` against an already-running Postgres (or run the suite from a normal terminal outside the sandbox).

## Adding a new E2E test

1) Start the server with `makeInProcessSyncRpcServer` (from `packages/sync-server/test/e2e/harness.ts`), then set `syncRpcUrl` to `${baseUrl}/rpc`.

2) Create one or more clients using `makeSynchrotronClientLayer(...)` and initialize:

- sync schema: `ClientDbAdapter.initializeSyncSchema`
- app schema: `CREATE TABLE ...`
- patch capture: `ClientDbAdapter.installPatchCapture([...])`

3) Define actions using `ActionRegistry.defineAction(...)` (the action function should close over the client’s `sql` and `clockService` as needed).

4) Use `SyncService` (the service) to drive behavior:

- `const sync = yield* SyncService`
- `yield* sync.executeAction(action)`
- `yield* sync.performSync()`
