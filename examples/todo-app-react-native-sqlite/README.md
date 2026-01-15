# Todo example (React Native + SQLite)

This is the React Native todo example, using SQLite via `@op-engineering/op-sqlite` (through a small `@effect/sql` adapter in `@synchrotron/sync-client`).

On web, it uses sqlite-wasm via `@effect/sql-sqlite-wasm` / `@effect/wa-sqlite` (no native modules) with OPFS persistence via `@effect/sql-sqlite-wasm`'s `OpfsWorker`.

## Prereqs

- Run the shared backend (Postgres + Electric + Bun RPC server) from `examples/backend`.
- This app is not compatible with Expo Go (it uses a native SQLite module). Use `expo prebuild` + a dev client.

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

## Run on web

From repo root:

```sh
pnpm --filter todo-app-react-native-sqlite run client:web
```

Notes:

- This app copies `@effect/wa-sqlite`’s wasm binaries into `examples/todo-app-react-native-sqlite/public/` on install (`postinstall`) so the web dev server can load them from `/wa-sqlite.wasm`.
  - If needed, run manually: `pnpm --filter todo-app-react-native-sqlite run sync:wa-sqlite-wasm`
- Web uses OPFS persistence via a Web Worker; this app imports `@expo/metro-runtime` in `examples/todo-app-react-native-sqlite/index.ts` to enable Metro’s web worker bundling.

To point the app at a non-local backend (LAN / physical device without USB reverse), set:

- `EXPO_PUBLIC_SYNC_RPC_URL=http://<YOUR_LAN_IP>:3010/rpc`
