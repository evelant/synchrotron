# 0004 — RLS Policies & Visibility Model (App + Sync Tables)

## Status

Proposed

## Summary

Synchrotron’s “private data convergence” story depends on PostgreSQL Row Level Security (RLS) to control what each user can read/write, including what action/patch log entries replicate to a client.

Today, the docs describe this at a high level but do not specify:

- what RLS policies must exist on **application tables**,
- how RLS should be applied to **sync tables** (`action_records`, `action_modified_rows`, `client_sync_status`),
- how to prevent **leakage via `action_records.args`**,
- how to make RLS filtering work given `action_modified_rows` only has `(table_name, row_id)`,
- what role/context the server uses when applying incoming patches (to ensure RLS `WITH CHECK` is enforced).

This doc is a placeholder to track that missing specification and converge on a recommended pattern for apps using Synchrotron.

## Goals

- **No row leakage**: a user must not receive rows or patches for rows they cannot see.
- **Write safety**: a user must not be able to write rows they are not allowed to write (RLS `WITH CHECK` enforced).
- **Minimal server logic**: the server does not run action logic; it stores logs and applies patches.
- **Concrete guidance**: provide an “RLS checklist” + example policies for a typical `tenant_id` / `user_id` model.

## Problem Areas To Specify

### 1) Application tables (required)

Apps must define RLS policies for all synced tables, including both:

- `USING (...)` (read visibility)
- `WITH CHECK (...)` (write constraints)

Synchrotron should document the expected “user context” mechanism (e.g., Postgres role, session variables/JWT claims) and how Electric sets it for shape queries.

### 2) Sync tables visibility (required)

We need a clear rule for what a user is allowed to see:

- `action_modified_rows`: should only be visible when the underlying `(table_name,row_id)` is visible.
- `action_records`: must not leak sensitive `args`; visibility must be scoped or args must be restricted.

### 3) Mapping `(table_name,row_id)` → visibility (hard)

RLS policies can’t easily express “visible iff the referenced row is visible” when `table_name` is dynamic.

Options to evaluate/document:

- **Denormalize scope columns**: require each synced table to include standard scoping columns (e.g. `tenant_id`, `user_id`) and have triggers copy them onto `action_modified_rows` (and optionally `action_records`) so RLS can be expressed without dynamic table access.
- **Per-table patch tables**: store patches in per-table AMR tables so each can have a normal FK + RLS policy.
- **SECURITY INVOKER visibility function**: add an allowlisted function like `sync_row_visible(table_name, row_id)` and use it in RLS policies (correctness/perf needs careful review).

### 4) Patch application under RLS (required)

If the server applies patches using a privileged role that bypasses RLS, dishonest writes become possible even if clients are “mostly honest”.

We need to specify:

- the server execution role constraints (avoid `BYPASSRLS`),
- whether patch application must run “as the originating user”,
- or whether patch application uses SECURITY INVOKER helpers to enforce RLS checks.

## Deliverables (What This Doc Should Eventually Contain)

- A recommended schema/policy pattern for multi-tenant apps (example SQL).
- Guidance on what is safe/unsafe to put in `action_records.args`.
- Recommended conventions for scoping columns across synced tables.
- A test plan + reference tests for RLS filtering on both data and sync tables.

## Related

- SYNC semantics depend on these constraints: `docs/planning/todo/0003-sync-action-semantics.md`.
- “Reliable fetch cursor” is separate from RLS: `docs/planning/todo/0002-reliable-fetch-cursor.md`.
