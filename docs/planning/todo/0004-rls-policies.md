# 0004 — RLS Policies & Visibility Model (App + Sync Tables)

## Status

Partially implemented (v1 demo)

## Summary

Synchrotron’s “private data convergence” story depends on PostgreSQL Row Level Security (RLS) to control what each user can read/write, including what action/patch log entries replicate to a client.

Today, the docs describe this at a high level but do not specify:

- what RLS policies must exist on **application tables**,
- how RLS should be applied to **sync tables** (`action_records`, `action_modified_rows`, `client_sync_status`),
- how to prevent **leakage via `action_records.args`**,
- how to make RLS filtering work given `action_modified_rows` only has `(table_name, row_id)`,
- what role/context the server uses when applying incoming patches (to ensure RLS `WITH CHECK` is enforced).

This doc is a placeholder to track that missing specification and converge on a recommended pattern for apps using Synchrotron.

## Implemented (v1 demo)

- Sync metadata scoping: `action_records.user_id` (nullable; server sets it from auth context).
- Server request context: server sets `synchrotron.user_id` via `set_config(..., true)` per request/transaction.
- RPC auth (demo v1): `packages/sync-server/src/SyncAuthService.ts` derives `user_id` for each request:
  - Preferred: `Authorization: Bearer <jwt>` (HS256; `sub` → `user_id`; optional `aud`/`iss` checks).
  - Dev-only fallback: `x-synchrotron-user-id` when no JWT secret is configured.
- Example backend: `examples/backend/src/db/setup.ts` creates a non-superuser role `synchrotron_app`, installs RLS policies on sync tables + `todos`, and runs the RPC server under that role.
- Tests: `packages/sync-server/test/rls-filtering.test.ts` proves (a) fetch is filtered by user and (b) patch-apply is rejected when it violates `WITH CHECK`.
- Next: remove the dev header fallback for non-demo deployments, and add support for JWKS / key rotation + richer claim mapping (`docs/planning/todo/0010-jwt-auth.md`).

## Key Decision: `client_id` ≠ authenticated identity

Synchrotron already uses `client_id` as a **device/runtime identity**:

- it is part of HLC ordering and total order tie-breaking
- it distinguishes concurrent writers
- multiple devices for the same human user should have different `client_id`s

RLS should be based on an **application principal identity** (typically `user_id`).

If we attempted to use `client_id` as the RLS principal:

- two devices for the same user would not be able to see each other’s actions (no convergence)
- “reset identity” would become a security boundary (not acceptable)

So we need a distinct notion:

- `client_id`: device/runtime (existing)
- `user_id`: authenticated principal (new, for RLS)

## Goals

- **No row leakage**: a user must not receive rows or patches for rows they cannot see.
- **Write safety**: a user must not be able to write rows they are not allowed to write (RLS `WITH CHECK` enforced).
- **Minimal server logic**: the server does not run action logic; it stores logs and applies patches.
- **Concrete guidance**: provide an “RLS checklist” + example policies for a typical `user_id`-scoped model.

## Problem Areas To Specify

### 1) Application tables (required)

Apps must define RLS policies for all synced tables, including both:

- `USING (...)` (read visibility)
- `WITH CHECK (...)` (write constraints)

Synchrotron should document the expected “user context” mechanism (e.g. session variables derived from JWT claims) and how both:

- the RPC server, and
- Electric’s shape endpoint

set that context so Postgres RLS can evaluate policies.

### 2) Auth identity + Postgres request context (required)

We need a stable identifier available to Postgres RLS for every server-side operation (fetch + ingest + patch-apply).

Recommended model:

- the client authenticates using a normal app mechanism (e.g. `Authorization: Bearer <jwt>`)
- the server verifies the token and extracts `{ user_id }`
- the server sets Postgres “request context” for the duration of the DB transaction

Avoid: trusting a `user_id` in the RPC payload as the security boundary.
For development/demos we may temporarily accept a header like `x-synchrotron-user-id`,
but the long-term model should be “server derives identity from auth”.

Pick a single convention for RLS policies to read from. Two common options:

1. Custom GUC variables (simple, works everywhere):
   - `set_config('synchrotron.user_id', <user_id>, true)`
2. JWT claim convention (Supabase/PostgREST-style), if we want compatibility later:
   - `set_config('request.jwt.claim.sub', <user_id>, true)`
   - `set_config('request.jwt.claims', <json>, true)`

For now, use custom GUCs (clearer and doesn’t imply any specific auth provider).

Implementation note: use `SET LOCAL` / `set_config(..., true)` inside a transaction so the context is cleared at commit/rollback.

### 3) Sync tables visibility (required)

We need a clear rule for what a user is allowed to see:

- `action_modified_rows`: should only be visible when the underlying `(table_name,row_id)` is visible.
- `action_records`: must not leak sensitive `args`; visibility must be scoped or args must be restricted.

Pragmatic v1 (enables per-user apps quickly):

- add `user_id` column to `action_records`
- RLS on `action_records` filters by `user_id` from request context
- RLS on `action_modified_rows` is expressed via `EXISTS (...)` join to `action_records` by FK (`action_record_id`)

This avoids dynamic table-name checks and is enough for “each user only sees their own data” apps (including “same user on multiple devices”).

For shared/collaborative data across users, we will likely need additional scope columns (see below).

### 4) Mapping `(table_name,row_id)` → visibility (hard)

RLS policies can’t easily express “visible iff the referenced row is visible” when `table_name` is dynamic.

Options to evaluate/document:

- **Denormalize scope columns**: require each synced table to include standard scoping columns (e.g. `user_id`, `project_id`) and have triggers copy them onto `action_modified_rows` (and optionally `action_records`) so RLS can be expressed without dynamic table access.
- **Per-table patch tables**: store patches in per-table AMR tables so each can have a normal FK + RLS policy.
- **SECURITY INVOKER visibility function**: add an allowlisted function like `sync_row_visible(table_name, row_id)` and use it in RLS policies (correctness/perf needs careful review).

For collaborative/shared tables, “scope denormalization” is likely the most ergonomic:

- `action_modified_rows` carries stable, typed scope columns (e.g. `project_id`)
- RLS policies for the sync tables can check membership tables using those scope columns
- no dynamic SQL / table dispatch required

This does require schema + trigger changes on both Postgres and SQLite adapters.

### 5) Patch application under RLS (required)

If the server applies patches using a privileged role that bypasses RLS, dishonest writes become possible even if clients are “mostly honest”.

We need to specify:

- the server execution role constraints (avoid `BYPASSRLS`),
- whether patch application must run “as the originating user”,
- or whether patch application uses SECURITY INVOKER helpers to enforce RLS checks.

Recommended model:

- server connects as a non-superuser DB role that does not have `BYPASSRLS` and does not own the tables
- server sets request context (`synchrotron.user_id`) per RPC request
- all patch application functions remain `SECURITY INVOKER` (default in Postgres; do not use `SECURITY DEFINER`)
- application tables + sync tables have RLS enabled (and ideally `FORCE ROW LEVEL SECURITY` so table owners can’t bypass by accident)

## Args leakage (important constraint)

`action_records.args` is replicated to clients (via RPC fetch and/or Electric sync of `action_records`).

Therefore:

- Either treat `args` as non-sensitive and safe-to-share within the scope of the RLS policy for `action_records`, or
- Split/encode args so sensitive fields are not present in the visible row (future work).

For v1, we assume apps only store “safe-to-replicate” inputs in args.

## Deliverables (What This Doc Should Eventually Contain)

- A recommended schema/policy pattern for per-user apps (example SQL).
- Guidance on what is safe/unsafe to put in `action_records.args`.
- Recommended conventions for scoping columns across synced tables.
- A test plan + reference tests for RLS filtering on both data and sync tables.

Concrete implementation work (tracked as follow-ups once this spec is agreed):

- Add server-side auth plumbing:
  - extract `{user_id}` in an RPC/HTTP middleware
  - wrap every DB-using RPC handler in `sql.withTransaction` + `set_config(..., true)` context
- Update schema:
  - add `user_id` column to `action_records` (and/or derive from request context)
  - add RLS policies for `action_records` + `action_modified_rows`
- Update `examples/backend`:
  - create roles and connect the RPC server with a role that is subject to RLS (not `postgres`)
  - add RLS policies for `todos` to demonstrate end-to-end enforcement
- Decide what “secure Electric” looks like for this repo:
  - Electric runs `ELECTRIC_INSECURE=true` today; that bypasses the whole RLS story
  - either wire Electric auth (recommended), or gate Electric mode behind a “dev only / insecure” warning

## Related

- SYNC semantics depend on these constraints: `docs/planning/todo/0003-sync-action-semantics.md`.
- “Reliable fetch cursor” is separate from RLS: `docs/planning/todo/0002-reliable-fetch-cursor.md`.
