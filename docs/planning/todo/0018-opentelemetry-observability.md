# 0018 — OpenTelemetry observability (Effect-native tracing + metrics)

## Status

In progress (Jan 2026)

Implemented so far:

- Local dev backend container: `grafana/otel-lgtm` in `examples/backend/docker-compose.yml`
- Minimal Grafana dashboards (Prometheus): `examples/backend/grafana/dashboards/`
- Backend trace export: `examples/backend/src/server.ts` installs `@effect/opentelemetry` via `@synchrotron/observability`
- Backend + clients optional OTLP log export (Loki): enable with `*_OTEL_LOGS_ENABLED=true` in the example `.env` files
- Backend + clients optional OTLP metrics export (Prometheus/Mimir): enable with `*_OTEL_METRICS_ENABLED=true` in the example `.env` files
- Web + React Native trace export: example runtimes install tracing via `@synchrotron/observability/web`
- Initial domain metrics + improved span semantics:
  - sync-core metrics: `packages/sync-core/src/observability/metrics.ts`
  - RPC spans are `kind=client/server` and carry `rpc.*` attributes
  - PGlite statement spans are `kind=client` and carry `db.*` attributes; PGlite also emits basic DB statement metrics

## Summary

Synchrotron already wraps most critical sync phases in `Effect.withSpan(...)` and uses structured logging / log annotations, but **we do not currently export those spans/metrics anywhere**. This doc proposes adding an optional, app-level OpenTelemetry integration using Effect’s `@effect/opentelemetry` so that:

- the example backend can export traces (and later metrics) to a local dev backend
- web + React Native examples can also export client-side telemetry (where feasible)
- we standardize what we measure (names, attributes, low-cardinality metrics)

See:

- Effect tracing docs: `docs/vendor/effect-otel.md`
- Effect metrics docs: `docs/vendor/effect-metrics.md`

## Problem

- Core packages already create spans (`Effect.withSpan`) and annotate them, but without an installed tracer these are effectively no-ops.
- We want to measure:
  - sync latency, retries, reconcile frequency, apply cost
  - RPC / network behavior and errors
  - DB query patterns and hotspots (especially PGlite/SQLite in clients)
- We need a low-friction local stack that developers can run alongside `examples/backend`.

## Goals / non-goals

### Goals

- **Traces first**: get end-to-end trace trees for `performSync()` and server RPC.
- Add **metrics** for low-cardinality “health + throughput” signals.
- Keep telemetry opt-in and environment-configurable (dev defaults are fine).
- Use Effect’s integration wherever possible (so spans/logs stay coherent).

### Non-goals

- Production-grade observability defaults (SLOs, long-term retention, multi-tenant backends).
- Perfect browser/RN auto-instrumentation on day 1 (we’ll validate and iterate).
- High-cardinality metrics (e.g. `clientId` as a metric label).

## Architecture direction

### Keep instrumentation in core; export at app boundaries

We should keep:

- span creation (`Effect.withSpan`, `Effect.annotateCurrentSpan`) in `sync-*` packages
- metric definitions (Effect `Metric.*`) near the domain logic they measure

But we should **export telemetry in the app entrypoints**, not inside core libraries. Concretely:

- add a small optional package (e.g. `packages/observability`) that provides `Layer`s for OTel SDK setup
- examples (backend/web/RN) depend on that package and provide those layers at startup

This avoids forcing OTel dependencies into every consumer bundle and keeps defaults easy to change.

### Node/Bun tracing layer (baseline)

Effect’s docs show a `NodeSdk.layer(() => ({ ... }))` pattern using an OTLP exporter over HTTP.

Baseline configuration (dev):

- resource attributes:
  - `service.name` (should identify the *app/service*, not Synchrotron-the-library)
  - `service.version` (from package.json, optional)
  - `deployment.environment` (`development` by default)
- span processor:
  - `BatchSpanProcessor(new OTLPTraceExporter({ ... }))` to send to a local collector
  - optionally: console exporter in “debug” mode
- exporter endpoint:
  - default to `http://localhost:4318` (OTLP HTTP) for local dev

#### Choosing `service.name`

`service.name` is what backends use to group/filter telemetry. It should be:

- chosen by the **consumer application** (e.g. `myapp-backend`, `myapp-web`, `myapp-mobile`)
- stable over time (version belongs in `service.version`)
- split by deployment unit (backend vs web vs RN are typically separate services)

For Synchrotron, this means:

- core libraries should not hardcode a `service.name`
- our example apps can default to human-friendly names:
  - `synchrotron-example-backend`
  - `synchrotron-example-web`
  - `synchrotron-example-react-native`
- the eventual observability layer should expose an override via config/env (e.g. `OTEL_SERVICE_NAME`)

**Bun note:** the example backend uses `@effect/platform-bun`. We’ll keep it on Bun and assume the OTel JS SDK works (Bun’s Node compatibility is strong). If we hit runtime issues, we’ll adapt in-place rather than introducing a separate Node entrypoint.

### Browser + React Native tracing layer (validation needed)

Goal: export client spans from `sync-client` + `sync-core` in web + RN apps.

Plan:

1. Start with a lightweight tracer provider (`@opentelemetry/sdk-trace-base`’s `BasicTracerProvider`) + OTLP/HTTP exporter. This works in both browser and React Native and avoids depending on the separate `sdk-trace-web` package.
2. If we hit browser-specific limitations, switch to the full web SDK (`@opentelemetry/sdk-trace-web` / `WebTracerProvider`) or adopt an RN-specific OTel SDK.

## Local dev backend (“metrics server”)

For developer UX, prefer a preconfigured all-in-one local stack.

Effect’s docs recommend Grafana’s “LGTM” OpenTelemetry dev image:

- `grafana/otel-lgtm` provides:
  - OpenTelemetry Collector (OTLP ingest)
  - Tempo (traces)
  - Prometheus (metrics)
  - Loki (logs)
  - Grafana (UI)

### Proposed dev workflow

- `examples/backend` continues to run the app on the host (Bun), while Postgres/Electric run in docker.
- Add a third docker service for `grafana/otel-lgtm`.
- Configure the backend process to export to `http://localhost:4318` (OTLP HTTP).

Implementation choice: **compose integration** — extend `examples/backend/docker-compose.yml` to include an `otel-lgtm` service, exposing `3001` (Grafana UI; configurable via `OTEL_LGTM_GRAFANA_PORT`), `4317` (OTLP gRPC), and `4318` (OTLP HTTP).

## What we’ll measure

### Traces (high-cardinality is OK here)

We already have good coverage of spans. We should standardize:

- root spans
  - `SyncService.performSync`
  - server `SyncNetworkRpc.*` request handling
- common attributes on key spans:
  - `clientId`
  - `syncSessionId`
  - `applyBatchId`, `sendBatchId`
  - `basisServerIngestId`, `lastSeenServerIngestId` (when relevant)
  - `dbDialect` / `db.system` (where relevant)

We should ensure span names are stable and follow a predictable hierarchy:

- `SyncService.*` for client sync phases
- `SyncNetworkService.*` for RPC/network calls
- `ClientDbAdapter.*` / `SqlClient.*` / `PgliteClient.*` for DB work

Avoid putting large payloads (SQL, args JSON) into span attributes by default; prefer:

- statement “shape” (operation + table) or a short tag
- explicit opt-in debug mode if we want raw SQL in dev

### Metrics (low-cardinality only)

Metrics should track “rates and distributions”, and avoid user/client identifiers as labels.

Proposed initial set:

- **Counters**
  - `synchrotron_sync_attempts_total{result}` (`result=success|failure`)
  - `synchrotron_sync_reconciles_total`
  - `synchrotron_actions_applied_total{source}` (`source=remote|local_replay|correction`)
  - `synchrotron_actions_uploaded_total`
  - `synchrotron_actions_downloaded_total`
  - `synchrotron_quarantine_total{reason}` (keep `reason` low-cardinality)
- **Timers / histograms**
  - `synchrotron_sync_duration_ms`
  - `synchrotron_apply_batch_duration_ms`
  - `synchrotron_rpc_duration_ms{method}`
  - `synchrotron_db_statement_duration_ms{dialect,op}` (keep `op` coarse)
- **Gauges**
  - `synchrotron_local_unsynced_actions` (count)
  - `synchrotron_remote_unapplied_actions` (count)

### Logs

Synchrotron’s logs already include correlation IDs (e.g. `syncSessionId`). We should:

- preserve those annotations
- optionally enrich logs with `traceId` / `spanId` where feasible
- decide whether “logs as span events” is sufficient for local dev, or if we want OTLP logs to Loki later

## Implementation plan (phased)

### Phase 0 — baseline traces (backend)

- Add dependencies (workspace-catalog versions already exist in `pnpm-workspace.yaml`):
  - `@effect/opentelemetry`
  - `@opentelemetry/api` (peer dependency)
  - `@opentelemetry/sdk-trace-base`
  - `@opentelemetry/sdk-trace-node`
  - `@opentelemetry/exporter-trace-otlp-http`
- Create `packages/observability` (or similar) providing:
  - `OtelConfig` (serviceName, endpoint, debug, sampling)
  - `OtelNodeLive` layer (NodeSdk + OTLP exporter)
- Wire `examples/backend/src/server.ts` to optionally provide `OtelNodeLive` before running `Layer.launch`.
- Add a local dev backend:
  - add `otel-lgtm` to `examples/backend/docker-compose.yml`
  - document the Grafana + OTLP endpoints in `examples/backend/README.md`

### Phase 1 — metrics export + dashboards

- Define initial `Metric` instruments in `sync-core` (counters/timers/gauges above).
- Export metrics via OpenTelemetry (confirm the Effect/OpenTelemetry integration approach for metrics).
- Add a minimal Grafana dashboard JSON (optional) or document Explore queries.

### Phase 2 — web + React Native export

- Wire a tracing layer near app init for:
  - Web example (`examples/todo-app-web-pglite`)
  - React Native example (`examples/todo-app-react-native-sqlite`)
- Validate OTLP HTTP export:
  - browser may require CORS-friendly collector config
  - mobile needs device/emulator networking (adb reverse can make `localhost` work on Android)

### Phase 3 — semantic conventions + propagation

- Apply OTel semantic conventions consistently (db/http/rpc attributes).
- Validate that client → server traces correlate end-to-end.
  - Note: `@effect/rpc` supports span propagation at the protocol layer (trace/span IDs are carried in the RPC request), so we likely don’t need header-based propagation for RPC.

## Test plan

- Unit-level:
  - run a small effect that creates a span and assert export via an in-memory exporter (no docker required)
- Example-level (manual/dev):
  - start `otel-lgtm`, run backend, trigger sync from web app, and confirm:
    - root span `SyncService.performSync` exists
    - server spans nest under the same trace (when propagation is enabled)
    - basic counters/histograms appear in Prometheus/Grafana (after Phase 1)

## Open questions

1. What should our example `service.name` defaults be (human-friendly vs package names), and should the observability layer expose an `OTEL_SERVICE_NAME` override?
2. Is “logs as span events” sufficient initially, or do we want true OTLP logs to Loki?
