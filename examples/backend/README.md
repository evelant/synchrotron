# Examples backend

Shared backend for Synchrotron examples:

- Postgres (Docker)
- Electric (Docker) on `http://localhost:5133`
- Synchrotron RPC server (Bun) on `http://localhost:3010/rpc`

## Run

From repo root:

```sh
pnpm run -r build
# Start backend docker containers
pnpm -C examples/backend run up
# Start backend dev server
pnpm -C examples/backend run dev
```

```sh
pnpm -C examples/backend run dev
```

Stop Docker services:

```sh
pnpm -C examples/backend run down
```

Reset the database (drops volumes):

```sh
pnpm -C examples/backend run reset
```
