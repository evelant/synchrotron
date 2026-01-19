# Examples backend

Shared backend for Synchrotron examples:

- Postgres (Docker)
- Electric (Docker) on `http://localhost:5133`
- Synchrotron RPC server (Bun) on `http://localhost:3010/rpc`

## RLS (demo wiring)

This backend installs demo RLS policies for:

- Sync tables: `action_records`, `action_modified_rows` (scoped by `action_records.user_id`)
- App table: `todos` (scoped by `todos.owner_id`)

The `db:migrate` step creates a non-superuser role `synchrotron_app` and grants it the required privileges, so RLS is actually enforced at runtime.

- Migrations use `ADMIN_DATABASE_URL` (typically `postgres`)
- The RPC server uses `DATABASE_URL` (typically `synchrotron_app`)

## RPC Auth (demo)

- Dev-only: when no JWT secret is configured, the client can send `x-synchrotron-user-id` and the server will treat it as `user_id` for RLS.
- Preferred: set `SYNC_JWT_SECRET` (or `GOTRUE_JWT_SECRET`) and have clients send `Authorization: Bearer <jwt>`; the server derives `user_id` from the token `sub` claim (Supabase-compatible default).

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
