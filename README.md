# Synchrotron

An opinionated yet flexible approach to offline-first data sync with [PGlite](https://pglite.dev/), [Electric SQL](https://electric-sql.com/), and [Effect](https://effect.website/).

Synchrotron is an offline-first data sync system using Effect-TS, PGlite, and Hybrid Logical Clocks (HLCs). It is unique (as far as I know) in that it executes business logic functions to advance state rather than using patches. It allows for unrestricted offline database operations while still guaranteeing eventual consistency, and all without requiring dedicated conflict resolution code. It operates like a CRDT but at the application level. For more details see [DESIGN.md](DESIGN.md).

## Status

### Experimental

- This is an experimental project and is not ready for production use
- There are comprehensive tests in packages/sync-core illustrating that the idea works
- API is split into packages: sync-client, sync-core, and sync-server
- There is an example app demonstrating basic functionality in examples/todo-app. It works online or offline and correctly syncs state between clients after coming back online. Does not yet handle multiple tabs in the same window (workers).
  - Run the example with:
    - `cd examples/todo-app`
    - `pnpm backend:up` (need docker running)
    - `pnpm dev`
    - Open http://localhost:5173 in your browser

### TODO

- Add tests for RLS (row level security). The system should work with RLS as-is but it's not tested yet. The design relies on RLS for security to filter out action_modified_rows affecting private data. This is what prevent unauthorized data from being sent to clients.
- Add end-to-end tests with the example app
- Add pruning for old action records to prevent unbounded growth. Add "rebase" function to clients who are offline long enough that they would need pruned actions to catch up.
- Improve the APIs. They're proof-of-concept level at the moment and could be significantly nicer.
- Consider a non-effect fascade. Effect is (IMO) the best thing that has ever happned to javascript but not everybody can adopt it. It would likely be simple to add a non-effect promise based wrapper.
- Add support for multiple clients in the same window (pglite workers)
- Add doc comments and typedoc gen
- Upstream @effect/sql-pglite (https://github.com/Effect-TS/effect/pull/4692)
- Improve docs
- Clean up logging and debug
- Improve example app, make it more real-world. Maybe add another based on [linearlite](https://github.com/electric-sql/electric/tree/main/examples/linearlite)
- Evaluate performance in a more real world use case. The example todo app seems plenty fast but performance with larger datasets is unknown and there is currently no optimization.

## How it works

Core principles:

1. **Business Logic Replay**: Unlike patch-based systems, Synchrotron replays your actual business logic functions (called actions) to advance state, maximally preserving user intent without dedicated conflict resolution code. Actions have full access to the local database, no restrictions on reads or writes. The only restriction on actions is that they capture all non-deterministic inputs (time, random values, network call results, etc) as arguments so they may be replayed. This does _not_ include database access because the system makes database access deterministic (as much as possible) without imposing signficant restrictions on actions.

2. **Server Authoritative**: Works with PostgreSQL Row Level Security with minimal server code, delegating conflict resolution to clients

3. **Action-Based**: All data changes occur through deterministic actions that can be recorded and replayed in the same order

4. **Patch Tracking**: Captures patches for server state advancement and divergence detection, not as the primary synchronization mechanism. Advancing state only through patches can result in "valid" states that are semantically invalid for the application because they're not aware of business logic rules.

5. **Conflict Resolution**: When conflicts occur, rolls back to common ancestor database state and replays actions in global order, letting your normal business logic handle invariants

## Capabilities

- **Intention Preservation**: Replays business logic instead of applying data patches, maintaining application invariants
- **Minimal Server Logic**: Leverages PostgreSQL RLS with almost no server side code required
- **Offline Operation**: Full functionality without connectivity
- **Conflict Resolution**: Uses existing business logic to handle conflicts naturally and according to your app's rules
- **Efficient Sync**: Fast realtime sync with electric-sql.
- **Deterministic IDs**: Content-based hashing for consistent id generation across clients
- **Transactional**: Atomic actions with database consistency
- **Eventual Consistency**: All clients reach same state even if there is private data and conditional logic that creates divergence in the results of replaying actions

## Usage

To ensure proper synchronization and avoid inconsistencies there are a few simple rules to follow:

1.  **Apply Sync Triggers:** The `applySyncTriggers` function (from `@synchrotron/sync-core/db`) must be called during your database initialization for _all_ tables whose changes should be tracked and synchronized by the system. This function sets up both the deterministic ID generation trigger and the patch generation trigger.
    ```typescript
    // Example during setup:
    import { applySyncTriggers } from "@synchrotron/sync-core/db"
    // ... after creating tables ...
    yield * applySyncTriggers(["notes", "todos", "other_synced_table"])
    ```
2.  **Action Determinism:** Actions must be deterministic aside from database operations. Capture any non-deterministic inputs (like current time, random values, user context not in the database, network call results, etc) as arguments passed into the action. The `timestamp` argument (`Date.now()`) is automatically provided. Row ids are generated automatically and deterministically on insert by hashing row content. You have full access to the database in actions, no restrictions on reads or writes.
3.  **Mutations via Actions:** All modifications (INSERT, UPDATE, DELETE) to synchronized tables _must_ be performed exclusively through actions executed via `SyncService.executeAction`. Direct database manipulation outside of actions will bypass the tracking mechanism and lead to inconsistencies.
4.  **No Manual IDs:** Do not manually provide or set the `id` column when inserting rows within an action. The system relies on the automatic, trigger-based deterministic ID generation to ensure consistency across clients. Remove any `DEFAULT` clauses for ID columns in your table schemas.

## Downsides and limitations

- Not a good fit for applications with high write volume data shared between many users. The greater the write volume and number of users writing a piece of data the more action records the system will need to sync and track. This could lead to performance issues. This algorithm is probably better suited to data that is naturally scoped to relatively smaller subsets of users. For high-write volume-broadly-shared data use a traditional through-server write strategy and electric-sql to sync changes.
- While designed to be broadly applicable and flexible it may not be a good fit for all applications. There is no one-size-fits-all for offline-first writes.
- It is deeply tied to the [Effect](https://effect.website/) library. Effect offers massive advantages in most areas over plain async TS but not everybody may be in a position to use it.

## License

MIT
