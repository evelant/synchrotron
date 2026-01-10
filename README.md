# Synchrotron

Offline-first sync for Postgres that converges by replaying business logic.

Synchrotron records deterministic _actions_ (your application business logic functions that mutate data) and syncs those, rather than treating row-level patches as the primary source of truth. When clients diverge, they roll back to a common ancestor and replay actions in a global order. This keeps business rules in one place and avoids writing bespoke conflict-resolution handlers.

It is designed to work with private data (Postgres RLS): actions can be conditional on private rows and still converge (per-user view) by emitting SYNC deltas when replay produces different results.

It also depends on a few simple but hard requirements (see Usage). They're not optional.

Built with [PGlite](https://pglite.dev/) (client-side Postgres), [Electric SQL](https://electric-sql.com/) (replication), and [Effect](https://effect.website/).

## Why actions?

Most offline sync stacks replicate table changes and settle concurrency with last-write-wins (or similar naive strategy). That converges, but it ignores semantic intent: two "valid" patches can still violate business rules, and you end up writing merge/conflict handlers on top.

Synchrotron moves the merge boundary up a level:

- You sync operations (actions), not just their resulting patches
- Conflicts resolve by rollback + replay of the same business logic
- Patches are still captured, but only for fast-forwarding, rollback, and divergence detection

## Status

### Experimental

- This is an experimental project and is not ready for production use
- There are comprehensive tests in `packages/sync-core` illustrating that the idea works
- API is split into packages: `sync-client`, `sync-core`, and `sync-server`
- There is an example app demonstrating basic functionality in `examples/todo-app`. It works online/offline and correctly syncs state between clients after coming back online. It does not yet handle multiple tabs in the same window (workers).
  - Run the example with:
    - `cd examples/todo-app`
    - `pnpm backend:up` (requires Docker)
    - `pnpm dev`
    - Open http://localhost:5173 in your browser

## Capabilities

- **Full offline SQL**: Actions can read/write the local database without CRDT-style restrictions
- **Intent preservation**: Invariants live in your actions and are re-applied during replay
- **No dedicated conflict-resolution code**: No per-field merge functions; resolution is "re-run the logic"
- **RLS-friendly**: PostgreSQL Row Level Security filters what each client can see; clients still converge
- **Deterministic IDs**: Inserts generate stable IDs from content so clients don't fight over primary keys
- **Eventual consistency**: Converges even with private data and conditional logic (via SYNC deltas)

## Differences

- **Patch/LWW replication**: Many offline-first strategies sync row/field changes and pick a winner (explicitly or implicitly). They converge, but semantic conflicts and invariant breaks are left to app code. Synchrotron merges by rerunning the mutation logic and only uses patches as a low-level mechanism for rollback/fast-forward.
- **CRDTs**: CRDT merges work at the data-structure level (field/column). They're great when your domain fits those types (such as a text editor), but cross-row/cross-table invariants still need separate handling. Synchrotron keeps your relational model and re-applies invariants by replaying actions.
- **Event sourcing**: Event sourcing is a persistence model where domain events are the source of truth. It doesn't, by itself, solve multi-writer offline merges or partial visibility (RLS). Synchrotron is a replication/convergence strategy not a persistence model. You can still emit domain events from actions for audit/integration if you want.
- **Write-through server + offline queue**: A common pattern is to queue API requests while offline and let the server be the only authority. That works, but it usually limits what "offline" can do and pushes conflict handling to server endpoints. Synchrotron lets clients execute full local transactions and reconcile later.
- **OT / collaborative editors**: OT is usually purpose-built for documents (text) with per-type transforms. Synchrotron is built around a database and general application mutations.

## How it works (high level)

- `executeAction` runs an action in a transaction and records `{ _tag, args, client_id, clock }`
- Triggers capture per-row forward/reverse patches into `action_modified_rows`
- `action_records` and `action_modified_rows` replicate via Electric SQL (filtered by RLS)
- Applying remote actions re-runs the action code; if produced patches don't match (usually due to private rows / conditionals), the client emits a SYNC action containing only the delta needed to converge
- If remote history interleaves with local unsynced actions, the client rolls back to the common ancestor and replays everything in HLC order

## TODO

- Add tests for RLS (row level security). The system should work with RLS as-is but it's not tested yet. The design relies on RLS to filter out `action_modified_rows` affecting private data, which prevents unauthorized data from being sent to clients.
- Formalize SYNC semantics (monotonic/additive deltas) and document recommended RLS policies for `action_records` / `action_modified_rows` (see `docs/planning/todo/0003-sync-action-semantics.md` and `docs/planning/todo/0004-rls-policies.md`).
- Add end-to-end tests with the example app
- Add pruning for old action records to prevent unbounded growth. Add a "rebase" function for clients that are offline long enough that they would need pruned actions to catch up.
- Improve the APIs. They're proof-of-concept level at the moment and could be significantly nicer.
- Consider a non-Effect facade. Effect is great, but not every codebase can adopt it; a Promise-based wrapper should be straightforward.
- Add support for multiple clients in the same window (PGlite workers)
- Add doc comments and typedoc gen
- Upstream @effect/sql-pglite (https://github.com/Effect-TS/effect/pull/4692)
- Improve docs
- Clean up logging and debug
- Improve example app, make it more real-world. Maybe add another based on [linearlite](https://github.com/electric-sql/electric/tree/main/examples/linearlite)
- Evaluate performance in a more real world use case. The example todo app seems plenty fast but performance with larger datasets is unknown and there is currently no optimization.

## Usage

Synchrotron only works if you follow these rules. They're simple, but they're hard requirements:

1.  **Apply Sync Triggers:** The `applySyncTriggers` function (from `@synchrotron/sync-core/db`) must be called during your database initialization for _all_ tables whose changes should be tracked and synchronized by the system. This function sets up both the deterministic ID generation trigger and the patch generation trigger.
    ```typescript
    // Example during setup:
    import { applySyncTriggers } from "@synchrotron/sync-core/db"
    // ... after creating tables ...
    yield * applySyncTriggers(["notes", "todos", "other_synced_table"])
    ```
2.  **Action Determinism:** Actions must be deterministic aside from database operations. Capture any non-deterministic inputs (like current time, random values, user context not in the database, network call results, etc.) as arguments passed into the action. The `timestamp` argument (`Date.now()`) is automatically provided. Row IDs are generated automatically and deterministically on insert by hashing row content. You have full access to the database in actions, no restrictions on reads or writes.
3.  **Mutations via Actions:** All modifications (INSERT, UPDATE, DELETE) to synchronized tables _must_ be performed exclusively through actions executed via `SyncService.executeAction`. Direct database manipulation outside of actions will bypass the tracking mechanism and lead to inconsistencies.
4.  **No Manual IDs:** Do not manually provide or set the `id` column when inserting rows within an action. The system relies on the automatic, trigger-based deterministic ID generation to ensure consistency across clients. Remove any `DEFAULT` clauses for ID columns in your table schemas.

## Downsides and limitations

- Not a good fit for applications with high write volume data shared between many users. The greater the write volume and number of users writing a piece of data the more action records the system will need to sync and track. This could lead to performance issues. This algorithm is probably better suited to data that is naturally scoped to relatively smaller subsets of users. For high-write volume-broadly-shared data use a traditional through-server write strategy and electric-sql to sync changes.
- While designed to be broadly applicable and flexible it may not be a good fit for all applications. There is no one-size-fits-all for offline-first writes.
- It is deeply tied to the [Effect](https://effect.website/) library. Effect offers massive advantages over plain async TypeScript, but not everybody can adopt it.

## Design

See [DESIGN.md](DESIGN.md) for design details.

## License

MIT
