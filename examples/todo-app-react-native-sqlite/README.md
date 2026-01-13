# Todo example (React Native + SQLite)

This is the React Native todo example, using SQLite via `@op-engineering/op-sqlite` (through a small `@effect/sql` adapter in `@synchrotron/sync-client`).

## Prereqs

- Run the shared backend (Postgres + Electric + Bun RPC server) from `examples/backend`.
- This app is not compatible with Expo Go (it uses a native SQLite module). Use `expo prebuild` + a dev client.

## Run backend

`pnpm dev` will start the shared backend (Postgres + Electric + Bun RPC server) automatically.

If you want to run it manually, from repo root:

```sh
# Start backend docker containers
pnpm -C examples/backend run up
# Start backend dev server
pnpm -C examples/backend run dev
```

## Run mobile app

From repo root:

```sh
pnpm -C examples/todo-app-react-native-sqlite typecheck
pnpm -C examples/todo-app-react-native-sqlite dev
```

For Android devices connected over USB, `pnpm dev` runs `adb reverse` so the app can use `http://localhost:3010/rpc`.

To point the app at a non-local backend (LAN / physical device without USB reverse), set:

- `EXPO_PUBLIC_SYNC_RPC_URL=http://<YOUR_LAN_IP>:3010/rpc`
