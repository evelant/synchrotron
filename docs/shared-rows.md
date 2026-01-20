# Shared rows: `audience_key`

For multi-user / collaborative data, clients must be able to receive each other’s actions *only* for rows they are allowed to see. Synchrotron does this with an application-defined `audience_key` token stored on both your app tables and the sync log.

## The model

- Every synced row belongs to exactly one “audience” (sharing scope).
- `audience_key` is an opaque string token (recommend `<kind>:<id>`), e.g. `project:123`, `dm:abc`, `user:alice`.

### Constructing `audience_key` (make it canonical)

RLS and sync-log filtering are simple equality checks on `audience_key`, so the key must be stable and canonical:

- Prefer `'<kind>:' || <stable id>` derived from a single column (project id, thread id, owner id, …).
- Keep it opaque: don’t embed sensitive data (emails, names, etc).
- Keep it cheap: compute from the row itself (string concat). Avoid triggers/functions that query other tables to compute it.
- Avoid encoding *sets* (e.g. a list of members) into the key. If you need “visible to many disjoint groups”, create an explicit share-group/audience id in your schema and use that as the `<id>`.
- If you must encode multiple parts, define a canonical order and delimiter so the same audience can’t produce multiple strings.

## Required schema (synced tables)

Every table tracked by `ClientDbAdapter.installPatchCapture([...])` must include:

- `audience_key TEXT` (Postgres / PGlite / SQLite)

Synchrotron’s patch capture:

- copies `NEW/OLD.audience_key` onto `action_modified_rows.audience_key` (indexed, used by RLS),
- strips `audience_key` out of the JSON patches (so patches stay generic and RLS checks stay fast).

### Compute it on insert (recommended)

Patch-apply inserts rows without specifying `audience_key`, so `audience_key` should be computed by the DB.

Postgres (generated column):

```sql
alter table todos
  add column audience_key text generated always as ('project:' || project_id::text) stored;
```

If you can’t use generated columns, compute it with a trigger or in application code.

### No “audience moves” via UPDATE

Changing `audience_key` is rejected. Model moves as `DELETE` + `INSERT` (new row id) so history stays unambiguous.

## Membership mapping: `synchrotron.user_audiences`

Each consuming app defines a fast mapping from `user_id` to the audiences that user can see:

```sql
create view synchrotron.user_audiences as
select
  user_id,
  ('project:' || project_id::text) as audience_key
from project_members;
```

For multiple sharing rules (projects, DMs, private rows), union them:

```sql
create view synchrotron.user_audiences as
select user_id, audience_key from project_members
union all
select user_id, audience_key from dm_participants;
```

If you want the server to accept late-arriving/offline actions across membership changes, treat membership/ACL state as part of canonical history (replayable) rather than mutating it out-of-band. See `docs/security.md`.

For performance, make membership checks index-friendly (this runs inside RLS):

- Prefer underlying membership tables that can answer `WHERE user_id = ? AND audience_key = ?` via an index (or a composite primary key).
- Avoid complex joins in the `user_audiences` view if the sync tables can return many rows.

## RLS patterns

Base table RLS:

```sql
create policy todos_read on todos
  for select
  using (
    exists (
      select 1
      from synchrotron.user_audiences a
      where a.user_id = current_setting('synchrotron.user_id', true)
        and a.audience_key = todos.audience_key
    )
  );
```

Sync table RLS (typical pattern):

- `action_modified_rows`: `USING/WITH CHECK` membership on `audience_key`.
- `action_records`: visible iff there exists at least one visible `action_modified_rows` row for that `action_record_id`.

If you also want to enforce that users can only insert AMRs for their *own* actions, avoid a direct `SELECT action_records ...` inside the `action_modified_rows` `WITH CHECK` (it can trigger Postgres RLS rewrite recursion). Use a `SECURITY DEFINER` helper like `synchrotron.action_record_belongs_to_user(action_record_id, user_id)` and call it from the policy instead.

See `examples/backend/src/db/setup.ts` for a working policy set.

## Constraints

- `action_records.args` are not redacted. If a user can read an `action_records` row, they can read its args.

### Multi-audience actions (args visibility)

`action_records` visibility is typically derived from visible AMRs:

- if a user can see **any** `action_modified_rows` row for an action, they can see the `action_records` row (and therefore `args`).

This is fine, but it means:

- args must be safe to reveal to the **union** of all audiences touched by that action.
- avoid “bulk” actions that touch many unrelated audiences *and* include cross-audience details in args (e.g. listing project ids); prefer per-audience actions or keep args audience-neutral.
