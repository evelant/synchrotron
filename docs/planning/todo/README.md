# Planning TODO Index

This folder contains **internal planning docs** for Synchrotron. These are not user-facing docs; keep the public contract in `README.md` / `DESIGN.md`.

## Active / Open

| ID     | Topic                                       | Status              | Next                                                                                                                                          |
| ------ | ------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `0018` | OpenTelemetry observability                 | In progress         | Validate end-to-end traces (web/RN → backend) in Grafana; handle any OTLP HTTP CORS issues; define initial metrics set.                       |
| `0015` | Failure modes + recovery (no stuck clients) | In progress         | Add discontinuity detection + unsyncable local work recovery; typed `SendLocalActions*` failures + bounded behind-head retry are implemented. |
| `0014` | Dev/test action purity check                | Proposed (optional) | Add an opt-in “replay twice” purity check (diagnostics only), likely for CI/dev.                                                              |
| `0013` | Transport abstraction (remote ingress)      | In progress         | Decide ingestion-only transport interface + wiring (upload stays RPC).                                                                        |

## Chores

- (none)

## Implemented (with follow-ups possible)

| ID     | Topic                                               | Status      |
| ------ | --------------------------------------------------- | ----------- |
| `0003` | CORRECTION action semantics (batch delta)           | Implemented |
| `006`  | CORRECTION conflicts (shared-field overwrites)      | Implemented |
| `0007` | Server materialization (authoritative patch apply)  | Implemented |
| `0010` | JWT auth for RPC (`user_id` for RLS)                | Implemented |
| `0011` | Shared rows via `audience_key` + membership mapping | Implemented |
| `0004` | RLS policies + visibility model                     | Implemented |
| `0012` | Membership churn vs server replay                   | Implemented |
| `0008` | Unify remote ingress + apply + applied cursor       | Implemented |
| `0009` | Example improvements / debug UX                     | Implemented |
| `0005` | Client DB abstraction (SQLite-first)                | Implemented |
| `0002` | Reliable fetch cursor (`server_ingest_id`)          | Implemented |
| `0001` | Indexable HLC sort key                              | Implemented |
| `0016` | Architecture + maintainability review               | Implemented |
| `0017` | Reconcile atomicity (crash-consistency)             | Implemented |

## Conventions

- New work: add a `docs/planning/todo/NNNN-*.md` doc and update this index.
- Prefer “one doc = one decision thread” (problem → constraints → plan → tests).
