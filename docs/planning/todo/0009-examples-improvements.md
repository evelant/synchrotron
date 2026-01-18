# 0009 — Example Improvements (Showcase + Debuggability)

## Status

Planned

## Summary

The examples are the primary way consumers understand Synchrotron. We should make them:

- demonstrate multi-client/offline reconciliation clearly
- highlight that Electric is optional (transport is pluggable)
- provide first-class debug affordances (identity, cursor, action counts, logs, reset)

This doc scopes improvements to the existing examples (web + React Native) and proposes a small “demo harness” mode for fast iteration.

## Problems

### 1) Hard to observe what sync is doing

Even with logs, it’s difficult to answer basic questions quickly:

- Which client id is this instance using?
- What is `last_seen_server_ingest_id`?
- How many actions are pending / synced / unapplied?
- Are we currently “fully synced” (Electric) or “polling” (RPC)?

### 2) No easy multi-client demo

The most compelling correctness stories require two clients:

- divergence while offline
- late-arriving actions
- rollback + replay + SYNC deltas

Today, reproducing these requires opening multiple tabs/devices and correlating logs manually.

### 3) Reset and lifecycle UX

Resetting local DB state (especially on RN-web/OPFS) has been a recurring pain point. We should:

- provide a reliable “reset local state” button per example
- clearly log “db exists / db created / schema initialized / client id loaded”
- keep identity reset (clear `sync_client_id`) explicit and intentional

## Goals / Non-goals

### Goals

- Add a simple “2 clients” mode in the web example (two isolated clients in one page).
- Add an “offline mode” toggle and “sync now” button to force deterministic demos.
- Surface key sync state in the UI (client id, applied cursor, action counts).
- Add an example configuration that does **not** use Electric (RPC-only ingress) to prove transport optionality.

### Non-goals

- RLS demos (separate work).
- Full E2E/browser automation (we can add later if needed).

## Proposed Work

### A) Web example: “Two Clients” demo harness

In `examples/todo-app-web-pglite`:

- Render two independent client instances side-by-side (“Client A” / “Client B”).
  - Each instance must have isolated storage (separate DB name / dataDir / KV namespace).
- Add controls per client:
  - `Sync now`
  - `Offline` (block outgoing upload + optionally block ingress)
  - `Reset local DB` (and optional `Reset identity`)
- Add a compact debug panel per client:
  - `clientId`
  - `last_seen_server_ingest_id`
  - `action_records`: total / unsynced / synced / synced-but-unapplied
  - `action_modified_rows`: total / unsynced

### B) React Native example: clarity + reset reliability

In `examples/todo-app-react-native-sqlite`:

- Keep the “Reset local DB” button, but make lifecycle logs very explicit:
  - startup
  - storage backend selection (OPFS / native sqlite)
  - db opened
  - schema initialized
  - client id loaded
- Add “Reset identity” as a separate explicit action (clears `sync_client_id` from KeyValueStore backend).

### C) Transport optionality showcase

Add a “RPC-only” configuration/mode in the web example:

- Disable Electric ingress entirely.
- Run `performSync` on an interval (polling) + a manual `Sync now`.

This demonstrates that transports are a choice, not a requirement, and provides a simpler baseline for debugging.

## Acceptance Criteria

- A new user can reproduce a divergence + reconciliation demo in < 2 minutes using the web example.
- The UI displays enough state to explain why an upload is rejected (cursor behind head) without digging through logs.
- Reset works reliably and predictably on RN-web and native.

