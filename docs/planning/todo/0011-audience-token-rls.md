# 0011 — Shared Rows: Audience Token RLS (Fast Sync-Log Filtering)

## Status

Implemented

## Summary

For owner-only apps, it’s sufficient to scope sync-log visibility by `action_records.user_id` (the originating authenticated principal).

For shared/collaborative rows, that model is wrong: users must be able to see other users’ actions on rows they share.

This doc proposes a **generic, performant** visibility model based on a single application-defined **audience token** (a.k.a. `audience_key`) that:

- does not require Synchrotron to understand each app’s RLS logic,
- avoids per-row JSON parsing inside RLS predicates,
- avoids dynamic SQL on `(table_name,row_id)`,
- still replicates **DELETE** operations correctly.

The key idea is to project the row’s “audience” onto sync-log rows as a single indexed token, then write sync-table RLS against a membership mapping.

## Problem Statement

We want `action_records` / `action_modified_rows` replication (via RPC fetch or Electric) to obey the same visibility boundaries as application tables.

The naïve expression:

- “AMR visible iff base row is visible” via `EXISTS (SELECT 1 FROM <table> WHERE id = row_id)`

is attractive because it reuses the base table’s own RLS, but it has problems:

- **Hard deletes break visibility** (row no longer exists).
- Implementing it generically requires dispatching on `table_name` (dynamic SQL / allowlists).
- It implies an extra indexed lookup per AMR row returned.

We need a model that:

- works under hard deletes without tombstones,
- can be expressed with cheap indexed predicates,
- is application-defined but library-supported.

## Proposed Model: `audience_key` + membership mapping

### 1) `audience_key` token (app-defined)

Each synced application row belongs to a single “audience” (scope) represented by an **opaque string token**:

- `audience_key: TEXT` (Postgres) / `TEXT` (SQLite)
- format is app-defined (recommended: `<kind>:<id>`):
  - `user:3c2d…`
  - `project:1b7f…`
  - `org:acme`

**Stability recommendation:** treat `audience_key` as stable for the row’s lifetime. If you need to “move” a row between audiences, model it explicitly (see “Audience moves”).

### 2) Membership mapping: `synchrotron.user_audiences`

This is the “application-specific” part of the pattern.

Apps define a fast membership mapping from authenticated user → visible audiences:

- a table (preferred for large sets) or a view (fine for demos)

This repo uses `synchrotron.user_audiences` as a _convention_ so the example RLS policies are copy/paste-able. It is not something Synchrotron can generate for you — each consuming app must implement it (or inline equivalent membership checks in its RLS policies).

Example (project membership):

```sql
-- Your app tables:
-- project_members(user_id text, project_id uuid)
-- todos(id uuid, project_id uuid, ..., audience_key text generated)

create view synchrotron.user_audiences as
select
  m.user_id,
  'project:' || m.project_id::text as audience_key
from project_members m;
```

Conceptually, this view/table answers:

- “for a given `user_id`, which `audience_key` values are visible?”

You can implement this however your app needs:

- Direct membership tables (`project_members`, `org_members`, etc)
- Role-based sharing (join through roles)
- “Private” audiences (each user is a member of `user:<their id>`)

## What this looks like in a real app (multiple tables, different rules)

The pattern is: pick an `audience_key` scheme, then make _every_ synced row belong to exactly one audience, even if different tables use different sharing logic.

Example app:

- `tasks`: shared within a project (all project members can read/write)
- `project_settings`: only project admins can read/write
- `messages`: only participants of a DM thread can read/write
- `private_notes`: only the owning user can read/write

### Audience keys per table

```sql
-- tasks are visible to project members
alter table tasks
  add column audience_key text generated always as ('project:' || project_id::text) stored;

-- settings visible only to admins
alter table project_settings
  add column audience_key text generated always as ('project_admin:' || project_id::text) stored;

-- DM messages visible to thread participants
alter table messages
  add column audience_key text generated always as ('dm:' || thread_id::text) stored;

-- private notes visible only to the owner
alter table private_notes
  add column audience_key text generated always as ('user:' || user_id::text) stored;
```

### Membership mapping

You can implement `synchrotron.user_audiences` as a view (or a table). The important part is: it produces `(user_id, audience_key)` and is fast to query.

For performance, prefer storing `audience_key` on your membership tables too (generated/stored) so the membership check is just an indexed equality.

```sql
-- Membership tables (examples)
-- project_members(user_id text, project_id uuid, audience_key text generated...)
-- project_admins(user_id text, project_id uuid, audience_key text generated...)
-- dm_participants(user_id text, thread_id uuid, audience_key text generated...)

create view synchrotron.user_audiences as
select user_id, audience_key from project_members
union all
select user_id, audience_key from project_admins
union all
select user_id, audience_key from dm_participants
union all
-- each user is implicitly a member of their own private audience
select u.id as user_id, ('user:' || u.id::text) as audience_key
from users u;
```

### Base table RLS

Each table can share the same “audience membership” predicate even though the _source_ of truth differs (project_members vs project_admins vs dm_participants):

```sql
create policy tasks_read on tasks
  for select
  using (
    exists (
      select 1
      from synchrotron.user_audiences a
      where a.user_id = current_setting('synchrotron.user_id')
        and a.audience_key = tasks.audience_key
    )
  );
```

Repeat for `tasks` write policies (`WITH CHECK`) and for other tables.

### Sync table RLS

The sync tables reuse the same membership check via `action_modified_rows.audience_key` (and `action_records` visibility derived from AMRs).

### Modeling complex sharing rules

If a table has “special” rules, you usually model it by choosing a different audience token space:

- “admins only” → `project_admin:<project_id>`
- “doc shared with a subset” → `doc:<doc_id>` with `doc_shares(user_id, doc_id)` feeding `user_audiences`

If a row needs to be visible to multiple disjoint groups, create an explicit “share group” entity (`audiences` table) and make the row reference that one audience id; membership becomes normal many-to-many.

### 3) Sync-log projection

Synchrotron stores `audience_key` on sync-log rows so RLS doesn’t need to introspect JSON:

- `synchrotron.action_modified_rows.audience_key TEXT NOT NULL`
- index: `CREATE INDEX ON synchrotron.action_modified_rows (audience_key)`

Optionally:

- `synchrotron.action_records.audience_key TEXT NULL`
  - only if we decide to enforce “single-audience actions” for stronger args isolation and simpler policies.

## How consuming apps implement this

### Step A — Add `audience_key` to each synced table

Recommended pattern: add `audience_key` as a generated column derived from existing schema.

Example (todos scoped by project):

```sql
alter table todos
  add column audience_key text generated always as ('project:' || project_id::text) stored;
```

Example (private rows scoped to user):

```sql
alter table notes
  add column audience_key text generated always as ('user:' || user_id::text) stored;
```

If you can’t use generated columns, compute it in application code or a trigger.

### Step B — Define membership mapping (`synchrotron.user_audiences`)

Create a table/view that returns `(user_id, audience_key)` for all audiences the user should see.

This is where your app’s auth/sharing logic lives.

### Step C — Base table RLS uses the same `audience_key`

For synced app tables, write RLS using the same `audience_key` + membership mapping.

Example:

```sql
create policy todos_read on todos
  for select
  using (
    exists (
      select 1
      from synchrotron.user_audiences a
      where a.user_id = current_setting('synchrotron.user_id')
        and a.audience_key = todos.audience_key
    )
  );
```

(Apps can inline membership checks directly instead of going through a view; the important part is: the base-table RLS and sync-log RLS must agree.)

## Sync table RLS (proposed)

### `action_modified_rows` visibility

RLS policy uses a fast membership check on `audience_key`:

```sql
create policy amr_read on synchrotron.action_modified_rows
  for select
  using (
    exists (
      select 1
      from synchrotron.user_audiences a
      where a.user_id = current_setting('synchrotron.user_id')
        and a.audience_key = action_modified_rows.audience_key
    )
  );
```

### `action_records` visibility

Synchrotron’s core visibility contract is:

- if a user can read an `action_records` row, they can read its `args` (no field-level redaction)

If `action_records` visibility is derived from AMR visibility (“visible if any AMR is visible”), then `args` are visible to the **union of audiences** touched by that action.

Application guidance:

- Treat `args` as shareable within that union (don’t put secrets in args).
- If some inputs must be private, store them in normal tables protected by app RLS and put only opaque references (ids) in `args`.
- Prefer actions that touch rows within a single audience to keep this union small and predictable (optional: enforce by storing `action_records.audience_key` and validating all AMRs match).

If we _don’t_ enforce single-audience actions, define `action_records` visibility as:

```sql
create policy ar_read on synchrotron.action_records
  for select
  using (
    exists (
      select 1
      from synchrotron.action_modified_rows amr
      join synchrotron.user_audiences a
        on a.audience_key = amr.audience_key
      where a.user_id = current_setting('synchrotron.user_id')
        and amr.action_record_id = action_records.id
    )
  );
```

Indexing note: make `action_modified_rows(action_record_id)` and/or `(action_record_id, audience_key)` fast.

### Sync-table write checks (`WITH CHECK`)

On ingest, ensure a user can only insert sync-log rows for audiences they belong to:

- `action_modified_rows` inserts: membership check on `audience_key`
- `action_records` inserts: at minimum enforce `user_id = current_setting('synchrotron.user_id')`

## Patch-capture requirements

For correctness, `audience_key` must be recorded on the AMR row at capture time.

Best option:

- require synced app tables to have an `audience_key` column
- patch capture copies `NEW.audience_key` / `OLD.audience_key` into `action_modified_rows.audience_key`

Optional hardening:

- also ensure `audience_key` is present in patches for UPDATEs (even when unchanged) so the server can verify consistency purely from patches during ingest.

## Deletes, revocation, and tombstones

### Deletes (hard delete) work without tombstones

This model can replicate deletes without joining the base table because:

- the AMR row stores `audience_key` captured from `OLD` (pre-delete)

So all members of that audience can see the delete AMR even though the base row no longer exists.

### Hard delete + rollback/replay (sync correctness cases)

Hard deletes are compatible with Synchrotron’s rollback/replay because `DELETE` AMRs already store a full pre-delete row snapshot in `reverse_patches`.

That gives us a simple set of behaviors with minimal special-casing:

- **Forward apply (`DELETE`)**:
  - if the row exists: delete it
  - if the row does not exist: treat as a no-op (end state is still “absent”)
- **Rollback (reverse apply of `DELETE`)**:
  - re-insert the row from `reverse_patches` (this is how we “go back in time” across a hard delete)

Common sync situations:

1. **Remote delete arrives, row exists locally** → delete removes it.
2. **Remote delete arrives, row is already missing locally** (fresh device, partial history, already-deleted-by-earlier-action) → delete is a no-op; this is still correct.
3. **Late-arriving older actions** (client/server learns about an older INSERT/UPDATE after applying a later DELETE):
   - reconcile does rollback to a common ancestor, which re-inserts the row from `reverse_patches`,
   - then replay in canonical order (INSERT/UPDATE before DELETE),
   - final state matches canonical history (row absent if the DELETE is still in-order).
4. **Concurrent delete vs update**:
   - canonical order decides whether the update “wins” (update before delete) or becomes a no-op (update after delete).
   - for best UX and determinism, actions that mutate existing rows should be written to handle “row missing” as a no-op (instead of throwing), because that’s the natural outcome when another client deleted first.

Soft delete is not required for rollback correctness; it’s an application choice for other reasons (see below).

### Access revocation does not “un-sync” local state

RLS prevents future fetches, but cannot force a client to delete data it already replicated while authorized.

If “purge-on-revocation” is needed for UX, it’s a separate client-side cleanup feature.

### Soft delete / tombstones (optional, prior art)

Soft delete can still be useful for:

- keeping rows around for referential integrity and action replay,
- enabling “AMR visible iff base row visible” policies (because the row still exists),
- deferred garbage collection.

Tradeoff: it increases application burden (queries/actions must treat “deleted” rows as absent, uniqueness rules may need to include/exclude deleted rows, etc). In many apps, hard delete + idempotent actions is simpler.

There’s existing prior art in this repo:

- `DESIGN.md` notes soft-deletes + later GC as a common approach for replay systems.
- Postgres patch trigger SQL includes a comment: “soft delete logic removed” (`packages/sync-core/src/db/sql/patch/generate_patches.ts`).
- Some tests reference a previously-required `deleted_at` column (now removed) (`packages/sync-core/test/db-functions.test.ts`).

If we want “visibility by joining base tables” in the future, a per-table tombstone strategy is the natural companion.

## Audience moves (scope changes)

If `audience_key` can change on UPDATE, you must decide semantics:

- simplest: **disallow** (recommended) and model moves as explicit `DELETE` + `INSERT`
- advanced: treat a move as “remove from old audience + add to new audience” (requires representing both audiences in sync-log; a single `audience_key` column is not enough)

For v1 shared rows, treat `audience_key` as stable.

## Implementation (this repo)

Implemented as:

- **Sync schema**: `action_modified_rows.audience_key` + indexes in `packages/sync-core/src/db/sql/schema/create_sync_tables.ts`.
- **Patch capture**: tracked tables must have `audience_key`; capture stores it on AMRs and strips it from JSON patches (see `packages/sync-core/src/db/sql/patch/*`).
- **Example backend**: `projects` / `project_members` / `todos` with a generated `audience_key` and a `synchrotron.user_audiences` view in `examples/backend/src/db/setup.ts`.
- **RLS policies**: sync-table and base-table policies use `audience_key` membership (see `examples/backend/src/db/setup.ts` and `packages/sync-server/test/e2e-postgres/harness.ts`).
- **Tests**: filtering and enforcement coverage in `packages/sync-server/test/rls-filtering.test.ts` plus Postgres e2e in `packages/sync-server/test/e2e-postgres/`.
- **Docs**: consumer-facing guidance in `docs/shared-rows.md` and `docs/security.md`.
