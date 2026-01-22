# 0010 — JWT Auth for RPC (derive `user_id` for RLS)

## Status

Implemented (HS256 + JWKS verifier)

## Summary

Synchrotron’s security story depends on Postgres RLS, which requires the server to derive a trustworthy `user_id` for each request and apply patches under that user context.

Today (demo v1):

- `packages/sync-server/src/SyncAuthService.ts` derives `user_id` per request from `Authorization: Bearer <jwt>` (required):
  - HS256 shared secret (`SYNC_JWT_SECRET` / `GOTRUE_JWT_SECRET`)
  - JWKS URL (for RS256/etc) (`SYNC_JWT_JWKS_URL`)
- The server sets `synchrotron.user_id` and `request.jwt.claim.sub` (via `set_config(..., true)` in a transaction) and stores `user_id` on `action_records.user_id`.
- RLS policies on `action_records` / `action_modified_rows` and application tables enforce visibility + `WITH CHECK`.

The recommended mechanism is JWT-based RPC auth:

- Client sends `Authorization: Bearer <jwt>`.
- Server verifies the JWT signature and claims.
- Server extracts `user_id` from `sub` (Supabase-compatible default) and uses it as the RLS principal.

The goal is to be compatible with most auth systems (including Supabase Auth / GoTrue) without binding Synchrotron to any one provider.

## Goals / Non-goals

### Goals

- Use a **standard** auth surface: `Authorization: Bearer <jwt>`.
- Server derives `user_id` from verified token; no identity in RPC payload.
- Keep `SyncServerService` independent of JWT specifics (it should just require `SyncUserId`).
- Provide a minimal “batteries included” JWT verifier for `packages/sync-server` that works with Bun + Node.
- Integrate cleanly with common auth setups:
  - Supabase Auth / GoTrue (HS256 shared secret)
  - Auth0 / Clerk / Firebase / Cognito (JWKS / RS256, issuer/audience checks)
  - “my backend already authenticates users” (custom auth service)

### Non-goals

- Implementing login / issuing tokens (that is always app-specific).
- Electric security (Electric is currently run in insecure mode for demos; secure Electric needs separate work).
- Multi-tenant scoping (`tenant_id`) for now; v1 is `user_id` only.

## What integrates best with real apps?

Most apps already have *one* of these:

1) **An identity provider that issues JWTs** (most common)
   - Web/mobile clients already have an access token.
   - Servers already have either an HS256 secret (Supabase/GoTrue) or a JWKS URL (Auth0/Clerk/Firebase/etc).
2) **A backend session/cookie model**
   - The browser sends cookies; there may not be a client-accessible JWT.

Synchrotron should make (1) trivial, and keep (2) possible via a pluggable server auth service.

## Options / decisions

### Option A — JWT (recommended)

Client sends JWT; server verifies it and derives `user_id`.

Pros:

- Compatible with most modern auth systems.
- Standard HTTP semantics; works with reverse proxies, middleware, etc.
- Removes “client-supplied identity” as a trust boundary.

Cons:

- Requires configuration (issuer keys / secret, issuer/audience checks).
- Key rotation / JWKS introduces caching complexity if we want to support it out of the box.

### Option B — Pluggable auth provider (recommended structure)

Define a `SyncAuthService` (or similar) that maps `HttpServerRequest → user_id`:

- JWT implementation: `Authorization: Bearer ...`.
- App implementation: session cookies, opaque tokens, mTLS, etc.

This keeps auth extensible while still letting Synchrotron ship a good default.

## Proposed Design (JWT + pluggable auth)

### 1) Standardize `user_id` extraction behind a small server service

Introduce a service in `packages/sync-server` (names TBD):

- `SyncAuthService.requireUserId: Effect<UserId, Unauthorized>`

Then `rpcRouter.ts` becomes:

- `const userId = yield* SyncAuthService.requireUserId`
- `serverService.receiveActions(...).pipe(Effect.provideService(SyncUserId, userId))`

This keeps JWT logic out of RPC handlers and makes the auth mechanism swappable.

### 2) JWT verification strategy

#### HS256 secret (implemented)

Implemented in `packages/sync-server/src/SyncAuthService.ts`:

- HS256 verifier (shared secret).
- Claim mapping:
  - `sub` → `user_id` by default (Supabase-compatible).
  - configurable via `SYNC_JWT_USER_ID_CLAIM`.
- Audience:
  - optional `SYNC_JWT_AUD` (fallback to `GOTRUE_JWT_AUD` for Supabase compatibility).
- Secret:
  - `SYNC_JWT_SECRET` (fallback to `GOTRUE_JWT_SECRET` for Supabase compatibility).
- Issuer:
  - optional `SYNC_JWT_ISSUER`.

This is the fastest path for Supabase/GoTrue apps: they already have the shared secret and an access token with `sub`.

#### Next: JWKS / RS256 (needed for “bring your own auth”)

Most hosted auth systems (Auth0, Clerk, Firebase, Cognito, …) sign tokens with asymmetric keys and publish a JWKS endpoint.

Implemented:

- `SYNC_JWT_JWKS_URL=<https://.../.well-known/jwks.json>`
- optional: `SYNC_JWT_ALG=RS256` (default), or a list of allowed algorithms
- issuer/audience checks (same as HS256)

Implementation note: `jose` supports `createRemoteJWKSet` which handles caching and key rotation.

### 3) Demo-only vs “real”

Decisions:

- **Default** `SyncAuthService` should require JWT verification (HS256 or JWKS).
- There is no “insecure identity header” fallback in the default server implementation.

### 3) Database/RLS wiring stays the same

- Server sets `synchrotron.user_id` per request/transaction.
- Server inserts `action_records.user_id = <derived user_id>`.
- RLS policies use `current_setting('synchrotron.user_id', true)`.

#### Optional: Supabase/PostgREST claim compatibility (user id only)

Supabase RLS commonly uses `auth.uid()`, which reads `current_setting('request.jwt.claim.sub')`.

Implemented: Synchrotron sets `request.jwt.claim.sub` alongside `synchrotron.user_id`:

```sql
select set_config('request.jwt.claim.sub', '<user_id>', true);
```

This happens for request handling and for server rollback+replay patch apply (patch SQL sets `request.jwt.claim.sub` from `action_records.user_id` per AMR).

Constraint: Synchrotron does not (and should not) preserve arbitrary JWT claims per action. RLS should not depend on ephemeral JWT claims beyond the user id if you want server replay to remain valid.

### 4) Client library changes

Synchrotron should not “own” auth, but we can make the default RPC transport ergonomic:

Implemented:

- `SynchrotronClientConfig.syncRpcAuthToken?: string` is supported as a convenience (static bearer token).
- `packages/sync-client/src/SyncRpcAuthToken.ts` provides `SyncRpcAuthToken` (token provider service):
  - default: reads the static config token (if present)
  - apps can override with a custom layer to fetch/refresh tokens per request

## Test Plan

Unit / integration tests in `packages/sync-server`:

- Missing `Authorization` header → `401` (or typed error mapped to RPC failure).
- Invalid signature / expired token → `401`.
- Valid token → handlers succeed and `SyncServerService` sees correct `user_id` context.
- RLS enforcement remains: unauthorized patch (e.g. `owner_id != user_id`) fails and no partial writes occur.

Implemented:

 - `packages/sync-server/test/jwt-auth.test.ts` covers HS256 + JWKS verification and basic failures.

Follow-ups (optional):

- Integration test for JWKS key rotation (ensures caching/rotation works in practice).
- Client-side example that refreshes tokens without restarting the runtime.

## Concrete next steps

1) Docs/examples: document the expected “bring your own auth” setups (HS256 vs JWKS) and show one snippet per (Supabase + generic JWKS provider).
2) Consider optional issuer/audience defaults for Supabase/GoTrue compatibility (`aud=authenticated`).
