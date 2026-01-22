# 0004 — RLS policies + visibility model (checklist)

## Status

Implemented (v1)

## Purpose

Capture a concrete, copy/paste-able RLS pattern for:

- app tables (your data), and
- the sync log tables (`action_records`, `action_modified_rows`)

so that:

- clients only replicate rows they are authorized to see,
- writes are rejected by Postgres RLS (`WITH CHECK`), and
- the server can still rollback+replay materialization to handle late-arriving actions.

Public docs:

- `docs/security.md`
- `docs/shared-rows.md`

## Checklist

### 1) Identity principal (`user_id`) + request context

- Use `user_id` as the authenticated principal (not `client_id`).
- For every RPC request / DB transaction, set the principal transaction-locally:

```sql
select set_config('synchrotron.user_id', '<user_id>', true);
```

### 2) DB role (RLS must actually apply)

The server’s DB role must not bypass RLS:

- `NOSUPERUSER`
- `NOBYPASSRLS`

Avoid connecting as `postgres` / table owner unless you also use `FORCE ROW LEVEL SECURITY`.

### 3) Shared-row scope: `audience_key` on every synced app table

Every table tracked by patch capture must have:

- `id TEXT PRIMARY KEY` (IDs are app-provided in Synchrotron)
- `audience_key TEXT NOT NULL`

`audience_key` should be stable for the row’s lifetime:

- scope moves are modeled as `DELETE` + `INSERT` (new row id)
- `UPDATE` that changes `audience_key` is rejected by the patch-capture trigger

Important implementation detail:

- patch capture stores `audience_key` on `action_modified_rows.audience_key` and strips it out of JSON patches
- patch apply:
  - does not write generated `audience_key` columns (the DB computes it)
  - for non-generated `audience_key` columns, it populates `audience_key` from `action_modified_rows.audience_key` on INSERT / reverse-INSERT (so `NOT NULL` + RLS `WITH CHECK` can succeed)

### 4) Membership mapping: `synchrotron.user_audiences`

Apps provide a fast mapping:

- `synchrotron.user_audiences(user_id, audience_key)`

Implementation can be a view or a table, but make it index-friendly:

- membership checks in RLS should ultimately be answerable via an index on `(user_id, audience_key)`

### 5) Base-table RLS (app tables)

For each synced table:

- `USING (...)` enforces read visibility
- `WITH CHECK (...)` enforces write constraints

In the shared-row model, both typically use the same predicate:

- “caller is a member of `audience_key`”

### 6) Sync-table RLS (client visibility + ingest safety)

Sync-table RLS has two distinct jobs:

1) **Client visibility**: filter `action_modified_rows` and `action_records` so clients only receive rows they’re authorized to see.
2) **Ingest-time safety**: reject a user inserting sync-log rows for an action they don’t own, or for an audience they aren’t a member of.

The v1 model is:

- `action_modified_rows` visibility is based on `action_modified_rows.audience_key` membership
- `action_records` visibility is derived from visible AMRs (if you can see any AMR for an action, you can see the action record + args)

### 7) Server materialization + membership churn

Server rollback+replay needs to read the full canonical sync log even when the *request user* cannot see it (e.g. after membership revocation). The recommended pattern is:

- allow sync-log `SELECT` when `synchrotron.internal_materializer=true` (transaction-local), additionally gated by DB role (`current_user = 'synchrotron_app'`)
- keep base-table RLS as the enforcement boundary by applying patches under the **originating action principal** (`action_records.user_id`)

Membership churn constraint (Option A):

- if base-table RLS depends on membership/ACL tables, treat those tables as part of canonical history (replayable); don’t mutate them out-of-band if you want late-arrival correctness across churn

### 8) Args visibility contract

- `action_records.args` are replicated verbatim (no redaction).
- If a user can see an action record (typically via any visible AMR), they can see its args.
- Treat args as non-sensitive across the union of audiences touched by the action (avoid multi-audience actions with sensitive args).

## Reference policy set (Postgres)

These snippets mirror the working policy set used in:

- `examples/backend/src/db/setup.ts`
- `packages/sync-server/test/e2e-postgres/harness.ts`

### Avoiding RLS rewrite recursion (42P17)

If `action_records` visibility is derived from `action_modified_rows`, then an `action_modified_rows` insert policy must not `SELECT action_records` through RLS (Postgres can recurse). Use a `SECURITY DEFINER` helper:

```sql
create schema if not exists synchrotron;

create or replace function synchrotron.action_record_belongs_to_user(action_record_id text, user_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from action_records ar
    where ar.id = $1 and ar.user_id = $2
  );
$$;

revoke all on function synchrotron.action_record_belongs_to_user(text, text) from public;
grant execute on function synchrotron.action_record_belongs_to_user(text, text) to synchrotron_app;
```

### Sync table policies

```sql
alter table action_records enable row level security;
alter table action_modified_rows enable row level security;

drop policy if exists synchrotron_action_records_select on action_records;
drop policy if exists synchrotron_action_records_insert on action_records;
drop policy if exists synchrotron_action_modified_rows_select on action_modified_rows;
drop policy if exists synchrotron_action_modified_rows_insert on action_modified_rows;

create policy synchrotron_action_records_select on action_records
  for select
  using (
    (
      current_setting('synchrotron.internal_materializer', true) = 'true'
      and current_user = 'synchrotron_app'
    )
    or exists (
      select 1
      from action_modified_rows amr
      join synchrotron.user_audiences a on a.audience_key = amr.audience_key
      where a.user_id = current_setting('synchrotron.user_id', true)
        and amr.action_record_id = action_records.id
    )
  );

create policy synchrotron_action_records_insert on action_records
  for insert
  with check (user_id = current_setting('synchrotron.user_id', true));

create policy synchrotron_action_modified_rows_select on action_modified_rows
  for select
  using (
    (
      current_setting('synchrotron.internal_materializer', true) = 'true'
      and current_user = 'synchrotron_app'
    )
    or exists (
      select 1
      from synchrotron.user_audiences a
      where a.user_id = current_setting('synchrotron.user_id', true)
        and a.audience_key = action_modified_rows.audience_key
    )
  );

create policy synchrotron_action_modified_rows_insert on action_modified_rows
  for insert
  with check (
    synchrotron.action_record_belongs_to_user(
      action_modified_rows.action_record_id,
      current_setting('synchrotron.user_id', true)
    )
    and exists (
      select 1
      from synchrotron.user_audiences a
      where a.user_id = current_setting('synchrotron.user_id', true)
        and a.audience_key = action_modified_rows.audience_key
    )
  );
```

### Base table policy template

For a synced table `todos(audience_key text, ...)`:

```sql
alter table todos enable row level security;

drop policy if exists todo_audience_policy on todos;

create policy todo_audience_policy on todos
  using (
    exists (
      select 1
      from synchrotron.user_audiences a
      where a.user_id = current_setting('synchrotron.user_id', true)
        and a.audience_key = todos.audience_key
    )
  )
  with check (
    exists (
      select 1
      from synchrotron.user_audiences a
      where a.user_id = current_setting('synchrotron.user_id', true)
        and a.audience_key = todos.audience_key
    )
  );
```

## Test coverage

- In-process RLS tests (PGlite): `packages/sync-server/test/rls-filtering.test.ts`
  - sync-log filtering by membership
  - base-table `WITH CHECK` enforcement during patch apply
  - membership churn scenarios (in-band vs out-of-band)
- End-to-end (real Postgres + HTTP RPC): `packages/sync-server/test/e2e-postgres/sync-rpc.e2e.test.ts`

## Follow-ups / non-goals

- Electric auth (secure shapes) is out of scope for v1; the example Electric setup is demo-only.
- JWKS/RS256, key rotation, and auth ergonomics live in `docs/planning/todo/0010-jwt-auth.md`.
- Multi-audience action ergonomics + conflict semantics live in `docs/planning/todo/006-sync-conflict.md`.
