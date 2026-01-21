# Security model (RLS + auth)

Synchrotron is designed for honest clients and relies on PostgreSQL Row Level Security (RLS) for data access control. The server is authoritative for the base tables, but it never runs application action code.

## RLS principal: `synchrotron.user_id`

Every server request that reads/writes synced tables must:

1. use a DB role that does **not** bypass RLS, and
2. set the request principal in the transaction:

```sql
select set_config('synchrotron.user_id', '<user_id>', true);
```

RLS policies (both app tables and sync tables) should reference:

```sql
current_setting('synchrotron.user_id', true)
```

## RPC authentication (JWT)

The demo RPC server requires:

- `Authorization: Bearer <jwt>` (server verifies and derives `user_id` from `sub`, Supabase-compatible defaults).

If you use the built-in HS256 verifier, configure:

- `SYNC_JWT_SECRET` (or `GOTRUE_JWT_SECRET`)
- optional: `SYNC_JWT_AUD` / `GOTRUE_JWT_AUD`, `SYNC_JWT_ISSUER`, `SYNC_JWT_USER_ID_CLAIM`, `SYNC_JWT_ALGORITHMS`

If you use a JWKS (RS256) verifier, configure:

- `SYNC_JWT_JWKS_URL`
- optional: `SYNC_JWT_AUD` / `GOTRUE_JWT_AUD`, `SYNC_JWT_ISSUER`, `SYNC_JWT_USER_ID_CLAIM`, `SYNC_JWT_ALGORITHMS`

Apps can replace the server auth service if they need a different mechanism (cookies, opaque tokens, JWKS, etc).

## Sync-table RLS

Recommended pattern (works for owner-only and shared rows): scope sync-log visibility by
`action_modified_rows.audience_key` membership (see `docs/shared-rows.md`). Owner-only apps can
model this as a `user:<user_id>` audience.

## Server materialization (rollback+replay)

- Patch apply must run under the originating principal (`action_records.user_id`), not the request principal. Synchrotron does this by setting `synchrotron.user_id` per action/AMR during replay.
- Sync-table RLS is for *client visibility*. The server materializer must be able to read the full canonical sync log to do rollback+replay, even if the current request user can’t see those rows (e.g. after membership revocation).
  - Recommended escape hatch for sync-table `SELECT` policies:
    - `current_setting('synchrotron.internal_materializer', true) = 'true'`
  - The server sets `synchrotron.internal_materializer=true` only in server code, and only transaction-locally (`set_config(..., true)`).
  - Guardrail (recommended): additionally require the server DB role, so this bypass can’t activate for other roles:
    - `current_user = 'synchrotron_app'`
    - Example:
      ```sql
      using (
        (current_setting('synchrotron.internal_materializer', true) = 'true' and current_user = 'synchrotron_app')
        or <normal client visibility predicate>
      )
      ```
- This bypass is only for reading the *sync log tables*. It must not bypass base-table RLS; base-table RLS remains the enforcement boundary during patch apply.
- If your base-table RLS depends on membership/ACL tables, those tables must be replayable as part of canonical history (don’t mutate them out-of-band if you want late-arrival correctness across membership churn).

## Sensitive data

`action_records.args` are replicated verbatim to any user who can read that `action_records` row (no field-level redaction). Keep args non-sensitive; store secrets in normal RLS-protected tables and pass ids/opaque references in args.

In shared-row setups, `action_records` visibility is commonly derived from visible `action_modified_rows` rows. If an action touches multiple audiences, anyone who can see any touched audience can see the action record + args. Keep args safe for that union (or avoid multi-audience actions).
