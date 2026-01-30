# Examples backend

Shared backend for Synchrotron examples:

- Postgres (Docker)
- Electric (Docker) on `http://localhost:5133`
- Local OpenTelemetry backend (Docker) on `http://localhost:3001` (Grafana; override with `OTEL_LGTM_GRAFANA_PORT`)
- Synchrotron RPC server (Bun) on `http://localhost:3010/rpc`

The OpenTelemetry dev stack also exposes:

- OTLP gRPC: `http://localhost:4317`
- OTLP HTTP: `http://localhost:4318`

## Viewing telemetry (Grafana / Tempo / Loki)

This repo currently exports **traces** (spans). We have not yet added app-level OTLP **metrics** export (you may still see **span-metrics** derived from traces).

- Open Grafana: `http://localhost:3001` (or whatever `OTEL_LGTM_GRAFANA_PORT` is set to).
- To view **traces**:
  - Go to **Explore**
  - Select the **Tempo** data source
  - Use the **Search** tab and filter by `service.name` (e.g. `synchrotron-example-web` / `synchrotron-example-backend`)
- If you’re seeing **raw counters** like “`sql.execute`” / “`PgliteClient.statement`”, you’re likely looking at **span-metrics** (aggregates derived from traces) in the Metrics data source — those are not the trace trees themselves.
- To view **logs**:
  - Set `OTEL_LOGS_ENABLED=true` (enabled by default in `examples/backend/.env.example`)
  - Go to **Explore**
  - Select the **Loki** data source
  - Query e.g. `{service_name="synchrotron-example-backend"}`
  - Note: Effect logs can also show up as *span events* inside traces.

Client logs:

- The web + React Native examples can also export OTLP logs to Loki (see their `.env.example` files for `*_OTEL_LOGS_ENABLED` + `*_OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`).

Troubleshooting backend traces:

- Ensure `pnpm dev:backend` is running with the OTel stack (`docker compose up` includes `otel-lgtm`).
- Ensure `OTEL_SDK_DISABLED` is not set to `true`.
- If you suspect `localhost` resolution issues, set `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` in `examples/backend/.env`.

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
