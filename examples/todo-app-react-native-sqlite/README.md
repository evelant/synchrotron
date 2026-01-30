# Todo example (React Native + SQLite)

This is the React Native todo example, using SQLite via `@op-engineering/op-sqlite` (through a small `@effect/sql` adapter in `@synchrotron/sync-client`).

On web, it uses sqlite-wasm via `@effect/sql-sqlite-wasm` / `@effect/wa-sqlite` (no native modules) with OPFS persistence via `@effect/sql-sqlite-wasm`'s `OpfsWorker`.

## Prereqs

- Run the shared backend (Postgres + Electric + Bun RPC server) from `examples/backend`.
- This app is not compatible with Expo Go (it uses a native SQLite module). Use `expo prebuild` + a dev client.
- Install `react-native-mmkv` (used by Synchrotron for persistent `KeyValueStore` on native).

## Run backend

`pnpm dev` will start the shared backend (Postgres + Electric + Bun RPC server) automatically.

If you want to run it manually, from repo root:

```sh
# Start backend (docker + dev server)
pnpm dev:backend
```

## Run mobile app

From repo root:

```sh
pnpm --filter todo-app-react-native-sqlite run typecheck
pnpm dev:react-native
```

For Android devices connected over USB, `pnpm dev` runs `adb reverse` so the app can use `http://localhost:3010/rpc`.

The dev stack also exposes OpenTelemetry OTLP HTTP on `http://localhost:4318/v1/traces`. `pnpm dev` now includes that port in the default `adb reverse` set so Android devices can export traces to the host collector.

## Run on web

From repo root:

```sh
pnpm --filter todo-app-react-native-sqlite run client:web
```

Notes:

- This app copies `@effect/wa-sqlite`’s wasm binaries into `examples/todo-app-react-native-sqlite/public/` on install (`postinstall`) so the web dev server can load them from `/wa-sqlite.wasm`.
  - If needed, run manually: `pnpm --filter todo-app-react-native-sqlite run sync:wa-sqlite-wasm`
- Web uses OPFS persistence via a Web Worker; this app imports `@expo/metro-runtime` in `examples/todo-app-react-native-sqlite/index.ts` to enable Metro’s web worker bundling.
- If you get “stuck” local data on web (OPFS), use the in-app `Reset DB` / `Reset ID` buttons.
  - On web, `Reset DB` switches the app to a fresh OPFS sqlite file name (stored in localStorage) and reloads. This avoids needing to delete OPFS files (which can be blocked by open handles).
  - `Reset ID` also clears the persisted `sync_client_id` and reloads the app.
  - Note: this only resets **local** state; if the backend still has action history, it will be re-fetched and re-applied on the next sync.

To point the app at a non-local backend (LAN / physical device without USB reverse), set:

- `EXPO_PUBLIC_SYNC_RPC_URL=http://<YOUR_LAN_IP>:3010/rpc`

## Env vars

Copy `examples/todo-app-react-native-sqlite/.env.example` to `examples/todo-app-react-native-sqlite/.env` for a working local setup.

Required:

- `EXPO_PUBLIC_SYNC_RPC_AUTH_TOKEN` (JWT for RPC auth; `sub` is used as `user_id` for RLS)
- `EXPO_PUBLIC_SYNC_USER_ID` (used by app code; should match the JWT `sub`)

Optional:

- `EXPO_PUBLIC_TODO_PROJECT_ID=project-demo` (defaults to `project-demo`)
- OpenTelemetry:
  - `EXPO_PUBLIC_OTEL_ENABLED` (default: `true`)
  - `EXPO_PUBLIC_OTEL_SERVICE_NAME` (default: `synchrotron-example-react-native`)
  - `EXPO_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (default: `http://localhost:4318/v1/traces`)
