# Examples backend

Shared backend for Synchrotron examples:

- Postgres (Docker)
- Electric (Docker) on `http://localhost:5133`
- Synchrotron RPC server (Bun) on `http://localhost:3010/rpc`

## Run

From repo root:

```sh
pnpm run -r build
# Start backend (docker + dev server)
pnpm dev:backend
```

Stop Docker services:

```sh
pnpm docker:down
```

Reset the database (drops volumes):

```sh
pnpm docker:reset
```
