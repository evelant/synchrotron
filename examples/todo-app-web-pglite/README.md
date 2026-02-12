# Todo example (Web + PGlite)

TodoMVC-style demo app for Synchrotron (ElectricSQL + Effect + PGlite).

This example includes a **two-client demo harness** in a single page, with a small debug panel per client:

- `clientId`
- `last_seen_server_ingest_id`
- action log counts (unsynced / synced / unapplied)

By default, Client A and Client B run as **different users** (`user1` / `user2`) in the same demo project (`project-demo`) so you can see shared-row replication in action (RLS-scoped by audience membership).

It also supports two transport modes:

- **RPC (polling)**: manual/interval `requestSync()` with a per-client offline toggle
- **Electric (ingress)**: Electric streams the sync metadata tables; the client applies remote actions from its local DB

## Setup

From the repo root:

```shell
pnpm install
pnpm run -r build
```

## Run backend (shared)

`pnpm dev` will start the shared backend (Postgres + Electric + Bun RPC server) automatically.

If you want to run it manually, use:

```shell
pnpm dev:backend
```

The backend compose also includes a local OpenTelemetry dev stack (`grafana/otel-lgtm`):

- Grafana: http://localhost:3001
- OTLP HTTP (traces): http://localhost:4318/v1/traces
- OTLP HTTP (logs): http://localhost:4318/v1/logs
- OTLP HTTP (metrics): http://localhost:4318/v1/metrics

## Run the web app

Then:

```shell
cd examples/todo-app-web-pglite
```

Now start the app:

```shell
pnpm dev
```

This runs a Bun-based dev setup on http://localhost:5173:

- `bun build --watch ./index.html --outdir dist` (builds the browser bundle)
- `bun server.ts` (serves `dist/` and the PGlite runtime assets over HTTP)

## Resetting local state

Each client instance has buttons:

- `Reset DB (keep id)`: clears the local app + sync tables inside that client’s PGlite database (without generating new sync patches)
- `Reset DB + identity`: also clears that client’s `sync_client_id` (localStorage namespace) so a new id is generated

Note: these only reset **local** state. If the backend still has action history, it will be re-fetched and re-applied on the next sync.

Important: by default the server fetch excludes actions where `client_id == your clientId` (avoid echo), but when a client has no local action log (`action_records` is empty) it will fetch with `includeSelf=true` from `sinceServerIngestId=0` to restore its own previously-synced history. This makes `Reset DB (keep id)` a workable “restore from server” flow.

Note: the app also attempts a best-effort IndexedDB delete for the underlying PGlite storage, but some browsers may block deletion while a handle is still open. The in-DB reset is the correctness-critical part.

Note: Bun's HTML-import dev server currently rewrites `new URL("./pglite.wasm", import.meta.url)`-style references inside some dependencies to `file://...` URLs in the browser bundle, which browsers refuse to load. Serving the `bun build` output avoids that and keeps PGlite's WASM/data loads on HTTP.

To produce a static build in `dist/`:

```shell
pnpm build
```

When you're done, stop the backend services using:

```shell
pnpm docker:down
```

## Env vars

Dev scripts load both `.env` and `.env.example` (in that order), so `.env.example` acts as a fallback for any missing variables.
Copy `examples/todo-app-web-pglite/.env.example` to `examples/todo-app-web-pglite/.env` if you want to customize the values.

Variables:

- `VITE_SYNC_RPC_AUTH_TOKEN_A` / `VITE_SYNC_RPC_AUTH_TOKEN_B`: JWTs for the two demo users (required for RPC auth).
- `VITE_SYNC_USER_ID_A` / `VITE_SYNC_USER_ID_B`: override demo user ids (defaults: `user1` / `user2`).
- `VITE_TODO_PROJECT_ID`: override demo project id (default: `project-demo`).
- OpenTelemetry:
  - `VITE_OTEL_ENABLED` (default: `true`)
  - `VITE_OTEL_SERVICE_NAME` (default: `synchrotron-example-web`)
  - `VITE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (default: `http://localhost:4318/v1/traces`)
  - `VITE_OTEL_LOGS_ENABLED` (default: `false`)
  - `VITE_OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (default: `http://localhost:4318/v1/logs`)
  - `VITE_OTEL_METRICS_ENABLED` (default: `false`)
  - `VITE_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (default: `http://localhost:4318/v1/metrics`)
