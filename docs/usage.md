# Using Synchrotron (app developer guide)

This doc is the “how do I actually wire this up?” guide. It focuses on the **client** integration
contract: what Synchrotron assumes about your schema and how actions + patch capture + sync fit together.

For the full algorithm and data model, read `../DESIGN.md`.

## Mental model

- Your app writes happen inside **actions** (deterministic business logic functions).
- Each action execution records an immutable row in `action_records`.
- Patch-capture triggers record row-level forward/reverse patches in `action_modified_rows`.
- Sync converges by **replaying actions** (rollback + replay when histories diverge), using patches for
  fast rollback/fast-forward and divergence detection.

## Quick start checklist

1. Choose a client DB layer (`@synchrotron/sync-client`):
   - PGlite (web): `makeSynchrotronClientLayer`
   - PGlite + Electric ingress (web): `makeSynchrotronElectricClientLayer` or `ElectricTransport`
   - SQLite (WASM): `makeSynchrotronSqliteWasmClientLayer`
   - SQLite (React Native): `@synchrotron/sync-client/react-native`
2. Initialize:
   - `ClientDbAdapter.initializeSyncSchema`
   - create/migrate your app tables
   - `ClientDbAdapter.installPatchCapture([...trackedTables])`
3. Define actions via `ActionRegistry.defineAction(...)` and execute them with `SyncService.executeAction(...)`.
4. Trigger sync with `SyncService.requestSync()` (polling apps can schedule it; push-ingress transports
   emit `SyncIngress` events and the core runner triggers it for you).

## Hard requirements (don’t skip these)

### 1) All synced writes must go through `SyncService.executeAction`

Patch capture rejects direct writes (unless patch tracking is explicitly disabled during rollback/apply).

### 2) Actions must be deterministic

If an action reads `Date.now()`, `Math.random()`, makes network calls, or depends on ambient state that isn’t
in the DB, replay can diverge.

Rule: **capture nondeterminism in args**. `timestamp` is part of the args schema and is injected
automatically when you create an action, then preserved for replay.

### 3) Tracked tables must have stable row identity

Synchrotron uses deterministic IDs so different clients don’t fight over primary keys.

When creating a client layer, you must provide `rowIdentityByTable` (aka `DeterministicIdIdentityConfig`):

```ts
import { makeSynchrotronClientLayer } from "@synchrotron/sync-client"

const clientLayer = makeSynchrotronClientLayer({
  rowIdentityByTable: {
    // stable identity columns (recommended)
    notes: ["audience_key", "note_key"]
    // or: notes: (row) => ({ audience_key: row.audience_key, note_key: row.note_key })
  },
  config: {
    syncRpcUrl: "http://localhost:3010/rpc"
  }
})
```

### 4) IDs are app-provided (use `DeterministicId`)

Tracked tables should use application-provided primary keys (no DB-generated defaults).

Inside actions, use `DeterministicId` to generate stable UUIDs scoped to the current action id:

- the same action replay produces the same inserted row ids, and
- different clients won’t fight over primary keys for “the same logical row”.

See the Todo example action bundle:

- `../examples/todo-app-web-pglite/src/actions.ts`

### 5) Tracked tables must include `audience_key`

Every table tracked by patch capture must have an `audience_key TEXT` column.

- Owner-only apps can model this as `audience_key = 'user:' || user_id`.
- Shared/collaborative apps should use an app-defined audience token (see `./shared-rows.md`).

## Defining actions (recommended pattern)

Actions are registered into `ActionRegistry`, which is used during replay. A convenient pattern is to
define an app-specific Effect service that:

- depends on `ActionRegistry` + your repos/SQL client, and
- exports action creators for your UI to call.

See the Todo example action bundle:

- `../examples/todo-app-web-pglite/src/actions.ts`

## Installing patch capture

After your app tables exist (and after migrations that change tracked table schemas), install patch capture:

```ts
import { ClientDbAdapter } from "@synchrotron/sync-core"
import { Effect } from "effect"

export const initialize = Effect.gen(function* () {
  const adapter = yield* ClientDbAdapter
  yield* adapter.initializeSyncSchema

  // ... create/migrate app tables here ...

  yield* adapter.installPatchCapture(["notes", "todos"])
})
```

SQLite note: `installPatchCapture` inspects the current table schema to generate triggers, so call it
after migrations that add/remove columns on tracked tables.

SQLite note (booleans): declare boolean columns with `BOOLEAN` affinity (not `INTEGER`) so patch capture
can encode boolean values as JSON `true/false` (portable to Postgres). Numeric `0/1` patches can cause
false divergence and server-side apply failures.

## Triggering sync

Apps/transports should call `SyncService.requestSync()` (not `performSync()`):

- single-flight (no overlapping sync runs)
- burst coalescing (many triggers → fewer sync cycles)

Polling example: the web Todo app triggers `requestSync()` on an interval:

- `../examples/todo-app-web-pglite/src/routes/index.tsx`

Push-ingress example: Electric provides `SyncIngress` batches; the core ingress runner ingests them and
triggers `requestSync()` automatically:

- `../packages/sync-client/src/transports/ElectricTransport.ts`
- `../packages/sync-client/src/electric/ElectricSyncService.ts`

## Next docs

- Transport model: `./transports.md`
- Bootstrap snapshots: `./bootstrap.md`
- Security + RLS: `./security.md`
