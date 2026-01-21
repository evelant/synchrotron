# Planning TODO Index

This folder contains **internal planning docs** for Synchrotron. These are not user-facing docs; keep the public contract in `README.md` / `DESIGN.md`.

## Active / Open

| ID | Topic | Status | Next |
| --- | --- | --- | --- |
| `0004` | RLS policies + visibility model | Partially implemented | Consolidate the “v1 demo” policies into a clear checklist; ensure shared-row model + membership churn guidance is consistent with server materialization. |
| `0010` | JWT auth for RPC (`user_id` for RLS) | Partially implemented | Decide what’s “demo-only” vs “real”; consider JWKS/RS256 + token refresh ergonomics. |
| `0012` | Membership churn vs server replay | Proposed | Add regression test(s) and document the constraint: auth/membership state must be in canonical history if replay-time RLS is the security boundary. |
| `0003` | SYNC action semantics (batch delta) | Proposed | Implement diagnostics + dev/test purity checks; add tests for private divergence and fixed-point behavior. |
| `006` | SYNC conflicts (shared-field overwrites) | Proposed | Add tests + warnings/diagnostics; document app-level constraints for “view-dependent writes to shared fields”. |
| `0013` | Transport abstraction | Proposed (on hold) | Revisit after core semantics + server correctness stabilize. |

## Implemented (with follow-ups possible)

| ID | Topic | Status |
| --- | --- | --- |
| `0007` | Server materialization (authoritative patch apply) | Implemented |
| `0011` | Shared rows via `audience_key` + membership mapping | Implemented |
| `0008` | Unify remote ingress + apply + applied cursor | Implemented |
| `0009` | Example improvements / debug UX | Implemented |
| `0005` | Client DB abstraction (SQLite-first) | Implemented |
| `0002` | Reliable fetch cursor (`server_ingest_id`) | Implemented |
| `0001` | Indexable HLC sort key | Implemented |

## Conventions

- New work: add a `docs/planning/todo/NNNN-*.md` doc and update this index.
- Prefer “one doc = one decision thread” (problem → constraints → plan → tests).
