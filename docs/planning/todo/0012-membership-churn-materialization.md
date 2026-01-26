# 0012 — Membership churn vs server materialization (RLS + late arrival)

## Status

Implemented (Option A)

## Implemented (Option A)

This repo adopts **Option A** (replay-time RLS enforcement with replayable membership/ACL state):

- Server materialization applies patches under the **originating action principal** (`action_records.user_id`) so base-table RLS (`WITH CHECK`) is always enforced.
- Sync-table `SELECT` policies include an internal escape hatch so the server can read the full canonical sync log during rollback+replay:
  - `current_setting('synchrotron.internal_materializer', true) = 'true'` (transaction-local), additionally gated by server DB role.
- Therefore: any tables that influence base-table RLS decisions (membership/ACL) must be part of canonical history (replayable). Don’t mutate membership out-of-band if you want late-arrival correctness across churn.

Tests:

- `packages/sync-server/test/rls-filtering.test.ts` covers both:
  - success when membership changes are in-history (replayable), and
  - deterministic failure when membership changes out-of-band and a late arrival forces rollback+replay.

Consumer-facing docs:

- `docs/security.md`

## Problem

The server materializer applies `action_modified_rows` patches to base tables to reach the canonical end state. Today, that patch-apply path is intended to run **under the originating `user_id`** with **base-table RLS enabled**, so a client can’t write rows they aren’t allowed to access.

This interacts badly with **membership churn** when membership is treated as _out-of-band state_ (not part of the Synchrotron action history):

- Base-table RLS decisions depend on current membership (`synchrotron.user_audiences`).
- Late-arriving actions can force the server to **rollback+replay** base tables, which re-applies historical patches.
- If membership has since changed, reapplying historical patches under current RLS can fail, preventing the server from reaching the correct canonical state.

## Concrete scenario

Assume shared rows in `project:<id>` and base-table RLS is:

```sql
exists (
  select 1
  from synchrotron.user_audiences a
  where a.user_id = current_setting('synchrotron.user_id', true)
    and a.audience_key = todos.audience_key
)
```

Timeline:

1. `t=100`: userA executes action `A1` modifying a todo in `project:P` → server ingests + materializes.
2. `t=300`: userB executes action `B1` modifying the same project → server ingests + materializes.
3. `t=400`: userA is removed from project membership **out-of-band** (membership table changes, but not via the action log).
4. `t=50` (offline): userB later uploads an older action `C0` that must sort before `A1`.
5. Server needs to rollback+replay to incorporate `C0` in canonical order, which requires reapplying `A1`.
6. During replay, applying `A1` under `userA` now fails base-table RLS (userA is no longer a member), even though `A1` is already an accepted part of history.

Result: server materialization can get stuck or diverge from canonical history.

## Options

### Axis: what is the enforcement boundary?

There are two different “where does auth live?” models:

1. **Replay-time enforcement**: server materialization applies patches under base-table RLS (as-if each action ran under its `user_id` at that point in history).
2. **Ingest-time enforcement**: server checks authorization when accepting actions/AMRs, but materialization treats accepted history as authoritative and replays it without re-checking base-table RLS.

Option A is the replay-time model; Option B is the ingest-time model. They both can be correct, but they have different operational and security tradeoffs.

### Option A — Membership/visibility is part of canonical history (recommended)

Make any state that influences authorization **replayable**:

- Membership changes must be represented in the action log (client-originated actions or server-originated action records + AMRs).
- The server’s rollback+replay will then restore membership to the correct point-in-history before applying an action’s patches.

Pros:

- Keeps the “security via base-table RLS” story intact.
- Makes rollback+replay well-defined: RLS decisions are based on the same materialized state being replayed.

Cons / follow-ups:

- Consuming apps must avoid mutating membership/ACL state out-of-band (or must also record it as actions).
- Revocation visibility is subtle: once removed, a user may not be able to _see_ the revocation action via audience-based filtering. They’ll discover it via rejection / missing data unless we add a “revocation notification” pattern.
- Server materialization should apply patches **per action** under `action_records.user_id` (not under the current request user), otherwise per-user permission rules can be violated during replay.

### Option B — Decouple materialization from base-table RLS (apply as privileged)

Treat sync-log insertion as the enforcement point, and run patch-apply with a privileged role (bypassing base-table RLS).

Pros:

- Server can always rollback+replay even if membership churn happens out-of-band.
- Consumers can keep membership/ACL changes out-of-band if they want “revocation is immediate” semantics (offline uploads after revocation are rejected at ingest time).

Cons:

- **Security risk** unless we add robust verification at ingestion time that every AMR targets a row that truly belongs to its `audience_key` (and that the user is allowed to act on it). With the current `audience_key` model, a malicious client could forge `audience_key` on AMRs unless we add extra checks.
- Those checks tend to require per-table logic or dynamic SQL on `(table_name,row_id)`, which we explicitly wanted to avoid for v1.
- Makes the system harder to reason about: the base tables become “state derived from accepted history”, not “state enforced by RLS at replay time”.

### Option C — “Epoch barriers” / reject late arrivals across churn boundaries

Forbid server rollback across certain boundaries (membership churn, policy version bumps, etc).

This avoids replay failures but gives up on a core correctness property (“accept late arrival by HLC”) and is hard to specify cleanly.

## Test plan (to drive the decision)

Add a server materialization test that models membership churn + late arrival:

1. Seed project membership so userA and userB are members.
2. Ingest and materialize an action authored by userA on `project:P`.
3. Ingest and materialize a later action by userB on the same project.
4. Apply an out-of-band membership change revoking userA.
5. Ingest a late-arriving older action that forces rollback+replay.
6. Assert the server either:
   - **fails deterministically** with a clear error explaining “authorization state changed out-of-band; materialization cannot replay”, or
   - succeeds because we’ve adopted Option A or B.

Also add a “happy path” variant for Option A:

- record membership churn as a normal action/AMRs in the history (so rollback restores membership for the historical window),
- assert rollback+replay succeeds and canonical state matches.

## Recommendation (v1)

Prefer **Option A**:

- Keep patch-apply under base-table RLS (security boundary).
- Treat “tables used by RLS for authorization” as part of the canonical action history.
- Document the constraint clearly for consumers: avoid out-of-band mutations of membership/ACL state, or mirror them into the action log as server-originated actions.

Option B is a later optimization/escape hatch, but only after we add server-side AMR verification strong enough to replace base-table RLS.

## Consumer-facing summary

- If you want “as-if actions executed under RLS” and to accept offline/late-arriving actions relative to membership changes, you must make membership/ACL replayable (Option A).
- If you want “revocation is immediate; offline uploads after revocation are rejected” and don’t want to sync membership state, Option B can work but requires more server-side verification and is easier to get subtly wrong.
