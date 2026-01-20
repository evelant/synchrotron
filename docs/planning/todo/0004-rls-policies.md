# 0004 — RLS Policies & Visibility Model (App + Sync Tables)

## Status

Partially implemented (v1 demo)

## Summary

Synchrotron’s “private data convergence” story depends on PostgreSQL Row Level Security (RLS) to control what each user can read/write, including what action/patch log entries replicate to a client.

Today, the docs describe this at a high level but do not specify:

- what RLS policies must exist on **application tables**,
- how RLS should be applied to **sync tables** (`action_records`, `action_modified_rows`, `client_sync_status`),
- what the visibility contract is for **`action_records.args`** (and what is safe to store there),
- how to make RLS filtering work given `action_modified_rows` only has `(table_name, row_id)`,
- what role/context the server uses when applying incoming patches (to ensure RLS `WITH CHECK` is enforced).

This doc is a placeholder to track that missing specification and converge on a recommended pattern for apps using Synchrotron.

## Implemented (v1 demo)

- v1 visibility scope: `action_records.user_id` (nullable; server sets it from auth context). This is correct for owner-only apps, but not for shared rows.
- Server request context: server sets `synchrotron.user_id` via `set_config(..., true)` per request/transaction.
- RPC auth (demo v1): `packages/sync-server/src/SyncAuthService.ts` derives `user_id` for each request:
  - Preferred: `Authorization: Bearer <jwt>` (HS256; `sub` → `user_id`; optional `aud`/`iss` checks).
  - Dev-only fallback: `x-synchrotron-user-id` when no JWT secret is configured.
- Example backend: `examples/backend/src/db/setup.ts` creates a non-superuser role `synchrotron_app`, installs RLS policies on sync tables + `todos`, and runs the RPC server under that role.
- Tests: `packages/sync-server/test/rls-filtering.test.ts` proves (a) fetch is filtered by user and (b) patch-apply is rejected when it violates `WITH CHECK`.
- Next: remove the dev header fallback for non-demo deployments, and add support for JWKS / key rotation + richer claim mapping (`docs/planning/todo/0010-jwt-auth.md`).
- Limitation: the v1 policies primarily cover **per-user / owner-only** apps. Shared/collaborative data needs a different visibility model (see “Shared rows (membership-based visibility)” below).

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

- `action_modified_rows`: should only be visible when the underlying `(table_name,row_id)` is visible **and** the parent `action_records` row is visible (avoid “orphan” patches and args leakage).
- `action_records`: must not leak sensitive `args`; visibility must be scoped or args must be restricted.

Pragmatic v1 (enables per-user apps quickly):

- add `user_id` column to `action_records`
- RLS on `action_records` filters by `user_id` from request context
- RLS on `action_modified_rows` is expressed via `EXISTS (...)` join to `action_records` by FK (`action_record_id`)

This avoids dynamic table-name checks and is enough for “each user only sees their own data” apps (including “same user on multiple devices”).

For shared/collaborative data across users, filtering `action_records` by `user_id` is insufficient: other users need to see each other’s actions on shared rows. The recommended direction is to scope sync-table visibility by the underlying row’s *audience* (membership / sharing rules), not the originating `user_id` (see “Shared rows (membership-based visibility)” below).

### 4) Mapping `(table_name,row_id)` → visibility (hard)

RLS policies can’t easily express “visible iff the referenced row is visible” when `table_name` is dynamic.

Options to evaluate/document:

- **Denormalize scope columns**: require each synced table to include standard scoping columns (e.g. `user_id`, `project_id`) and have triggers copy them onto `action_modified_rows` (and optionally `action_records`) so RLS can be expressed without dynamic table access.
- **Per-table patch tables**: store patches in per-table AMR tables so each can have a normal FK + RLS policy.
- **SECURITY INVOKER visibility function**: add an allowlisted function like `sync_row_visible(table_name, row_id)` and use it in RLS policies (correctness/perf needs careful review).

For collaborative/shared tables, “scope denormalization” (typed scope columns) is ergonomic, but it’s also heavy-weight / library-opinionated.

An alternative that stays closer to “the underlying row is visible” while avoiding dynamic SQL is:

- **Patch-derived visibility keys (recommended direction)**: require each synced table to declare a small set of “visibility key columns” (e.g. `project_id`) and require patch capture to always include those key columns in the AMR’s JSON patches. Then RLS on the sync tables can be expressed by extracting key values from `forward_patches` / `reverse_patches` and checking membership tables — without needing to dynamically `SELECT` from the base table.

This approach is compatible with an append-only action log and avoids introducing a first-class “sync_scope” concept in the library. It does, however, require patch-capture changes (see below).

For collaborative/shared tables, “scope denormalization” might still be worth it long-term for performance and simpler policies, but the patch-derived-key approach is a good v2 target for correctness-first iteration.

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

## Args visibility (core constraint)

`action_records.args` is replicated to clients (via RPC fetch and/or Electric sync of `action_records`).

Synchrotron assumes:

- if a user can read an `action_records` row, they can read its `args` (no field-level redaction)

Therefore, applications must treat `args` as safe to share within whatever scope makes an `action_records` row visible:

- owner-only apps: the originating user’s scope
- shared rows: typically the union of audiences of the AMRs touched by that action

If some inputs must remain private, store them in normal tables protected by app RLS and put only opaque references (ids) in `args`.

## Shared rows (membership-based visibility)

The “per-user `action_records.user_id` filter” model is only correct for owner-only apps. For shared data, we want:

- sync-log visibility to match app-defined RLS visibility of the underlying rows (membership/sharing rules)
- the server to remain “patch-only” (no action logic replay server-side)
- deletes to propagate correctly even though the base row no longer exists

Concrete shared-row direction: `docs/planning/todo/0011-audience-token-rls.md`.

### Visibility keys

For each synced application table, the app defines a small set of **visibility key columns** that determine the row’s audience.

Examples:

- Private rows: `notes.user_id` (audience is that user)
- Shared rows: `todos.project_id` (audience is “members of that project”)

These keys must be *available on the AMR row* so we can write RLS policies without dynamically reading the base table.

### Patch-capture requirement (critical)

Today, update patches only include changed columns (see `generate_op_patches`), which means visibility keys won’t be present on a typical `UPDATE`.

To make membership-based visibility implementable, patch capture must guarantee:

- `INSERT`: `forward_patches` includes the visibility keys (already true: full row)
- `DELETE`: `reverse_patches` includes the visibility keys (already true: full old row)
- `UPDATE`: visibility keys are always included, **even when unchanged** (not true today; must be added)

This is the key reason deletes *can* work correctly with this model:

- a delete AMR can be authorized/filtered using the pre-delete visibility keys from `reverse_patches`, even though the base row is gone

### Performance note: avoid per-row JSON work in RLS

You’re right to be wary of “extract JSON then check membership” directly inside an RLS policy:

- RLS is evaluated for every row the query might return.
- JSON extraction + casts inside the policy can prevent simple index usage and add CPU overhead.

If we pursue the visibility-key approach, the *fast* version should materialize those keys into indexed columns on `action_modified_rows` at write time, so RLS becomes a plain indexed column predicate + membership check.

Two common patterns:

1) **Typed columns on `action_modified_rows`** (recommended):
   - The library can’t infer app-specific visibility keys; the application must choose them (and their Postgres types) and add the needed columns/indexes via migration.
   - Add per-table key columns (or a small generic set) like `project_id UUID`, `owner_user_id TEXT`, etc.
   - Fill them at capture time from patches (INSERT: `forward_patches`, DELETE: `reverse_patches`, UPDATE: either/both).
   - Create normal B-tree indexes on those columns.
   - RLS policy becomes: `EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = action_modified_rows.project_id AND m.user_id = current_setting('synchrotron.user_id'))`

2) **Generated / expression-indexed columns**:
   - Keep keys in patch JSON but add generated columns like:
     - `project_id UUID GENERATED ALWAYS AS (...) STORED`
   - Or add expression indexes on:
     - `((coalesce(forward_patches->>'project_id', reverse_patches->>'project_id'))::uuid)`
   - This still avoids repeated JSON extraction during query execution by letting the planner use the index.

Either way, “patch-derived” is about *where the truth comes from* (capture-time), not about forcing runtime JSON parsing in every RLS predicate.

### Would “join the base table” / dynamic SQL be better?

If we want “AMR visible iff underlying row is visible”, the most literal expression is:

- `EXISTS (SELECT 1 FROM <table> t WHERE t.id = action_modified_rows.row_id)`

This reuses the table’s own RLS (because the subquery runs under the caller and sees only visible rows).

Tradeoffs:

- **Deletes break** (row is gone) unless you add tombstones / soft deletes / a separate visibility table.
- **Dynamic SQL** (dispatching on `table_name`) is risky and typically slower; prefer an allowlisted `CASE` / per-table policies if you go this route.
- Even with static per-table `EXISTS`, you’re still doing an extra indexed lookup per AMR row returned.

So: joining the base table is attractive for correctness (“exactly match app RLS”) but incomplete for deletes and often heavier than a scope-key join against a small membership table.

### RLS policy sketch

Write per-table policies (safe allowlist by construction) that:

1) Filter `synchrotron.action_modified_rows` by `table_name = '<table>'`, then:
2) Extract visibility key(s) from patches, then:
3) Check membership / sharing tables using `current_setting('synchrotron.user_id')`

Then define `synchrotron.action_records` visibility as:

- visible iff `EXISTS` at least one visible `action_modified_rows` referencing that action id

This keeps `action_records.user_id` as an **origin/audit** column, not the visibility scope.

### Constraints / open questions

- **Visibility keys should be stable** (recommended): if a row “moves scopes” (e.g. `project_id` changes), a naive “OR old/new audience” policy risks leaking new values to an audience that should only see a removal. The simplest recommendation is: model scope moves as `DELETE` + `INSERT` (or otherwise avoid changing visibility keys).
- **Multi-scope actions**: if one action touches rows in different audiences, then “`action_records` visible if any AMR is visible” can leak `args` across scopes. Options:
  - constrain apps to single-scope actions, or
  - treat `args` as non-sensitive and acceptable to share with any audience that sees any AMR (v1 assumption), or
  - future: split args / redact / move to per-AMR metadata.
- **Revocation semantics**: RLS can prevent future syncing, but it can’t “make a client forget” data it already replicated while authorized. If we want local purge-on-revocation for UX, that’s a separate feature (client-side cleanup).

### Implementation plan (follow-up work)

- Add a way for apps/examples to declare visibility keys per synced table (likely metadata, used by patch capture).
- Update patch capture on both Postgres and SQLite adapters so `UPDATE` AMRs always include those keys.
- Update sync-table RLS policies in `examples/backend` to demonstrate a shared-data pattern (e.g. `project_members` + `todos.project_id`).
- Add E2E tests proving:
  - two different `user_id`s in the same project converge on shared rows
  - non-members cannot fetch/apply those rows
  - deletes propagate to all members via `reverse_patches` key extraction

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
