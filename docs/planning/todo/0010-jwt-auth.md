# 0010 — JWT Auth for RPC (derive `user_id` for RLS)

## Status

Partially implemented (HS256 demo verifier)

## Summary

Synchrotron’s security story depends on Postgres RLS, which requires the server to derive a trustworthy `user_id` for each request and apply patches under that user context.

Today (demo v1):

- `packages/sync-server/src/SyncAuthService.ts` derives `user_id` per request:
  - Preferred: `Authorization: Bearer <jwt>` when a JWT secret is configured.
  - Dev-only fallback: `x-synchrotron-user-id` when no JWT secret is configured.
- The server sets `synchrotron.user_id` (via `set_config(..., true)` in a transaction) and stores it on `action_records.user_id`.
- RLS policies on `action_records` / `action_modified_rows` and application tables enforce visibility + `WITH CHECK`.

The header fallback is useful for demos, but it is not a realistic auth boundary.

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
- Keep current header-based demo path as a development-only fallback.

### Non-goals

- Implementing login / issuing tokens (that is always app-specific).
- Electric security (Electric is currently run in insecure mode for demos; secure Electric needs separate work).
- Multi-tenant scoping (`tenant_id`) for now; v1 is `user_id` only.

## Options

### Option A — Keep `x-synchrotron-user-id` only (status quo)

Pros:
- Simple, easy to demo.
- No crypto, no dependencies.

Cons:
- Not an auth boundary.
- Encourages wiring that cannot be used in real apps.

### Option B — JWT (recommended)

Client sends JWT; server verifies it and derives `user_id`.

Pros:
- Compatible with most modern auth systems.
- Standard HTTP semantics; works with reverse proxies, middleware, etc.
- Removes “client-supplied identity” as a trust boundary.

Cons:
- Requires configuration (issuer keys / secret, issuer/audience checks).
- Key rotation / JWKS introduces caching complexity if we want to support it out of the box.

### Option C — Pluggable auth provider (recommended structure)

Define a `SyncAuthService` (or similar) that maps `HttpServerRequest → user_id`:

- Demo implementation: `x-synchrotron-user-id`.
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

### 2) JWT verification strategy (current implementation)

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

Future enhancements:

- JWKS URL + caching / key rotation.
- Support RS256/ES256 public-key verification.

### 3) Database/RLS wiring stays the same

- Server sets `synchrotron.user_id` per request/transaction.
- Server inserts `action_records.user_id = <derived user_id>`.
- RLS policies use `current_setting('synchrotron.user_id', true)`.

### 4) Client library changes

Synchrotron should not “own” auth, but we can make the default RPC transport ergonomic:

- Add an optional `SynchrotronClientConfig.syncRpcAuthToken` (bearer token) and pass it via `RpcClient.layerProtocolHttp({ transformClient })`.

Apps with dynamic tokens (refresh) may prefer providing their own `SyncNetworkService` layer or a custom `transformClient` function.

## Test Plan

Unit / integration tests in `packages/sync-server`:

- Missing `Authorization` header → `401` (or typed error mapped to RPC failure).
- Invalid signature / expired token → `401`.
- Valid token → handlers succeed and `SyncServerService` sees correct `user_id` context.
- RLS enforcement remains: unauthorized patch (e.g. `owner_id != user_id`) fails and no partial writes occur.

Implemented:

- `packages/sync-server/test/jwt-auth.test.ts` covers the JWT verifier + fallback behavior.

## Open Questions

- Should we keep `x-synchrotron-user-id` as a permanent dev-only fallback, or remove once JWT exists?
- Do we want JWT verification built-in, or should we only ship the `SyncAuthService` interface and leave JWT to apps?
- How should we support token refresh on the client (static config vs callback/service)?
- What’s the right error shape for auth failures in `@effect/rpc` (typed `UnauthorizedError` vs reusing `NetworkRequestError`)?
