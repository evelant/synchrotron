# Examples backend

Shared backend for Synchrotron examples:

- Postgres (Docker)
- Electric (Docker) on `http://localhost:5133`
- Synchrotron RPC server (Bun) on `http://localhost:3010/rpc`

## RLS (demo wiring)

This backend installs demo RLS policies for:

- Sync tables: `action_records`, `action_modified_rows` (scoped by `action_modified_rows.audience_key` membership via `synchrotron.user_audiences`)
- App tables: `todos` (scoped by project membership; `todos.audience_key` is generated from `project_id`)

It also seeds a demo project (`project-demo`) with two demo users (`user1`, `user2`) as members so the web example can demonstrate multi-user shared rows.

The `db:migrate` step creates a non-superuser role `synchrotron_app` and grants it the required privileges, so RLS is actually enforced at runtime.

- Migrations use `ADMIN_DATABASE_URL` (typically `postgres`)
- The RPC server uses `DATABASE_URL` (typically `synchrotron_app`)

## RPC Auth (demo)

- Set `SYNC_JWT_SECRET` (or `GOTRUE_JWT_SECRET`) and have clients send `Authorization: Bearer <jwt>`; the server derives `user_id` from the token `sub` claim (Supabase-compatible default).

Dev scripts load both `.env` and `.env.example` (in that order), so `.env.example` acts as a fallback for any missing variables.
Copy `examples/backend/.env.example` to `examples/backend/.env` if you want to customize the values (Postgres ports + JWT secret/audience).

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
