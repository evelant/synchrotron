# Synchrotron

An opinionated approach to offline-first data sync with [PGlite](https://pglite.dev/) and [Effect](https://effect.website/).

## Status

### Experimental
- This is an experimental project and is not ready for production use
- There are comprehensive tests in packages/sync-core illustrating that the idea works
- Packages are not organized, there is nothing useful in the client or server packages yet
- Missing an example app



## License

MIT


# Design Plan

## 1. Overview

This document outlines a plan for implementing an offline-first synchronization system using Conflict-free Replicated Data Types (CRDTs) with Hybrid Logical Clocks (HLCs). The system enables deterministic conflict resolution while preserving user intentions across distributed clients.

**Core Mechanism**: When conflicts occur, the system:

1. Identifies a common ancestor state
2. Rolls back to this state using reverse patches
3. Replays all actions in HLC order
4. Creates notes any divergences from expected end state as a new action

## 2. System Goals

- **Offline-First**: Enable optimistic writes to client-local databases (PgLite, single user postgresql in wasm) with eventual consistency guarantees
- **Intention Preservation**: Maintain user intent during conflict resolution
- **Deterministic Ordering**: Establish total ordering of events via HLCs
- **Performance**: Prevent unbounded storage growth and minimize data transfer
- **Security**: Enforce row-level security while maintaining client authority
- **Consistency**: Ensure all clients eventually reach the same state

## 3. Core Concepts

### Key Terminology

| Term                            | Definition                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Action Record**               | Database row representing a business logic action with unique tag, non-deterministic arguments, client ID, and HLC timestamp |
| **Action Modified Row**         | Database row linking actions to affected data rows with forward/reverse patches                                              |
| **Non-deterministic Arguments** | Values that would differ between clients if accessed inside an action (time, random values, user context)                    |
| **HLC**                         | Hybrid Logical Clock combining physical timestamp and vector clock for total ordering across distributed clients             |
| **Execute**                     | Run an action function and capture it as a new action record with modified rows                                              |
| **Apply**                       | Run an action(s) function without capturing a new record (for fast-forwarding, may capture a SYNC action if required)        |
| **SYNC Action**                 | Special action created when applying incoming actions produces different results due to private data and conditional logic   |
| **ROLLBACK Action**             | System action representing the complete set of patches to roll back to a common ancestor                                     |

### Action Requirements

1. **Deterministic**: Same inputs + same database state = same outputs
2. **Pure**: No reading from external sources inside the action
3. **Immutable**: Action definitions never change (to modify an action, create a new one with a different tag)
4. **Explicit Arguments**: All non-deterministic values must be passed as arguments
5. **Proper Scoping**: Include appropriate WHERE clauses to respect data boundaries

## 4. System Architecture

### Database Schema

1. **action_records Table**:

   - `id`: Primary key
   - `_tag`: Action identifier
   - `arguments`: Serialized non-deterministic inputs
   - `client_id`: Originating client
   - `hlc`: Hybrid logical clock for ordering (containing timestamp and vector clock)
   - `created_at`: Creation timestamp
   - `transaction_id`: For linking to modified rows
   - `synced`: Flag for tracking sync status

2. **action_modified_rows Table**:
   - `id`: Primary key
   - `action_record_id`: Foreign key to action_records
   - `table_name`: Modified table
   - `row_id`: ID of modified row
   - `operation`: The overall type of change, INSERT for inserted rows, DELETE for deleted rows, UPDATE for everything else
   - `forward_patches`: Changes to columns to apply (for server)
   - `reverse_patches`: Changes to columns to undo (for rollback)
   - `sequence`: Sequence number for ordering within a transaction (action)

3. **local_applied_action_ids Table**
   - `action_record_id`: primary key, references action_records, indicates an action_record the client has applied locally
### Components

1. **Action Registry**: Global map of action tags to implementations
2. **Database Abstraction**: Using `@effect/sql` Model class, makeRepository, and SqlSchema functions
3. **Trigger System**: PgLite triggers for capturing data changes
4. **Patch Generation**: Forward and reverse patches via triggers
5. **HLC Service**: For generating and comparing Hybrid Logical Clocks
   - Implements Hybrid Logical Clock algorithm combining wall clock time with vector clocks
   - Vector clock tracks logical counters for each client in the system
   - Vectors never reset. On receiving data client updates own vector entry to max of all entries.
   - On starting a mutation client increments their vector entry by +1
   - Provides functions for timestamp generation, comparison, and merging
   - Ensures total ordering across distributed systems with better causality tracking
6. **Electric SQL Integration**: For syncing action tables between client and server

### Backend Database State

1. **Append-Only Records**:

   - Action records are immutable once created
   - New records are only added, never modified
   - This preserves the history of all operations

2. **Server-Side Processing**:
   - Backend database state is maintained by applying forward patches
   - All reconciliation happens on clients
   - Server only needs to apply patches, not execute actions
   - This ensures eventual consistency as clients sync

## 5. Implementation Process

### Step 1: Database Setup

1. Create action_records and action_modified_rows tables
2. Implement PgLite triggers on all synchronized tables
3. Create PL/pgSQL functions for patch generation:
   - Triggers on each table capture changes to rows
   - Triggers call PL/pgSQL functions to convert row changes into JSON patch format
   - Functions update action_records with the same txid as txid_current()
   - Functions insert records into action_modified_rows with forward and reverse patches
   - Each modification to a row is recorded as a separate action_modified_row with an incremented sequence number

### Step 2: Core Services

1. Implement HLC service for timestamp generation:

   - Create functions for generating new timestamps with vector clocks
   - Implement comparison logic for total ordering that respects causality
   - Add merge function to handle incoming timestamps and preserve causal relationships
   - Support vector clock operations (increment, merge, compare)

2. Create action registry for storing and retrieving action definitions:

   - Global map with action tags as keys
   - Support for versioned action tags (e.g., 'update_tags_v1')
   - Error handling for missing or invalid action tags
   - Validation to ensure actions meet requirements

3. Implement database abstraction layer using Effect-TS

### Step 3: Action Execution

1. Implement executeAction function:

   - Start transaction
   - Fetch txid_current()
   - Insert action record with all fields
   - Run action function
   - Handle errors during execution (rollback transaction)
   - Commit (triggers capture changes)
   - Return success/failure status with error details if applicable

2. Implement applyActions function:
   - Similar to executeAction but without creating new records for each action
   - Create a SYNC action:
     - Triggers still capture changes during apply
     - Compare captured changes with incoming action_modified_rows patches
     - If differences exist (likely due to conditionals and private data) filter out identical patches and keep the SYNC action
     - SYNC action contains the diff between expected and actual changes
     - If there are no differences delete the SYNC action

### Step 4: Synchronization

1. Implement client-to-server sync:

   - ActionRecords and ActionModifiedRows are streamed from the server to the client with applied: false
   - Clients are responsible for applying the actions to their local state and resolving conlficts
   - For testing purposes during development a test SyncNetworkService implementation is used to simulate getting new actions from the server

2. Implement conflict detection:

   - Compare incoming and local unsynced actions using vector clock causality
   - Identify affected rows
   - Detect concurrent modifications (neither action happens-before the other)

3. Implement reconciliation process:
   - Find common ancestor (latest synced action record before any incoming or unsynced records)
   - Roll back to common state
   - Replay actions in HLC order
   - Create new action records

## 6. Synchronization Protocol

### Applying SYNC actions

1. If there are incoming SYNC actions apply the forward patches to the local state without generating any new action records.
2. This is because there is no action to run, the SYNC action is just a diff between expected and actual state to ensure consistency when modifications differ due to conditionals and private data.

The overall flow for SYNC actions is as follows:

1. Create one placeholder InternalSyncApply record at the start of the transaction.
2. Apply all incoming actions (regular logic or SYNC patches) in HLC order.
3. Fetch all patches generated within the transaction (generatedPatches).
4. Fetch all original patches associated with all received actions (originalPatches).
5. Compare generatedPatches and originalPatches.
6. Keep/update or delete the placeholder SYNC based on the comparison result.
7. If kept, send the SYNC action to the server and update the client's last_synced_clock.

### Normal Sync (No Conflicts)

1. Server syncs actions to the client with electric-sync (filtered by RLS to only include actions that the client has access to)
2. Client applies incoming actions:
   - If outcome differs from expected due to private data, create SYNC actions
   - Mark actions as applied
3. Client updates last_synced_hlc

### Detailed cases:

Here are the cases that need to be handled when syncing:

1. If there are no local pending actions insert a SYNC action record, apply the remote actions, diff the patches from apply the actions against the patches incoming from the server for all actions that were applied. Remove any identical patches. If there are no differences in patches the SYNC action may be deleted. Otherwise commit the transaction and send the SYNC action.
2. If there are local pending actions but no incoming remote actions then attempt to send the local pending actions to the backend and mark as synced.
3. If there are incoming remote actions that happened before local pending actions (ordered by HLC) then a ROLLBACK action must be performed and actions re-applied in total order potentially also capturing a SYNC action if outcomes differ. Send rollback and new actions to server once this is done.
4. If all remote actions happened after all local actions (by HLC order) do the same as 1. above
5. If there are rollback actions in the incoming set find the one that refers to the oldest state and roll back to that state if it is older than any local action. This ensures that we only roll back once and roll back to a point where no actions will be missed in total order. Skip application of rollback actions during application of incoming actions.

### Conflict Resolution

1. Client detects conflicts between local and incoming actions:

   - If there are any incoming actions that are causally concurrent or before local unsynced actions, conflict resolution is required
   - Vector clocks allow precise detection of concurrent modifications
   - If there are no local actions or all incoming actions happened after all local actions (by HLC order) then apply the incoming actions in a SYNC action as described above

2. Client fetches all relevant action records and affected rows:
   - All action records affecting rows in local DB dating back to last_synced_clock
   - All rows impacted by incoming action records (filtered by Row Level Security)
3. Client identifies common ancestor state
4. Client performs reconciliation:
   - Start transaction
   - Apply reverse patches in reverse order to roll back to common ancestor
   - Create a SINGLE ROLLBACK action containing no patches, just the id of the common ancestor action
   - Determine total order of actions from common state to newest (local or incoming)
   - Replay actions in HLC order with a placeholder SYNC action
   - Check the generated patches against the set of patches for the actions replayed
     - If the patches are identical, delete the SYNC action
     - If there are differences (for example due to conditional logic) keep the SYNC action with only the patches that differ
   - Send new actions (including rollback and SYNC if any) to server
   - If rejected due to newer actions, rollback transaction and repeat reconciliation
   - If accepted, commit transaction
5. Server applies forward patches to keep rows in latest consistent state
   1. Server also applies rollbacks when received from the client. It uses the same logic, finding the rollback action targeting the oldest state in the incoming set and rolling back to that state before applying _patches_ in total order.

### Live Sync

1. Use Electric SQL to sync action_record and action_modified_rows tables:
   - Sync records newer than last_synced_clock
   - Use up-to-date signals to ensure all action_modified_rows are received
   - Utilize experimental multishapestream and transactionmultishapestream APIs
2. Track applied status of incoming actions
3. Apply actions as they arrive
4. Perform reconciliation when needed
5. Send local actions to server when up-to-date

### Initial State Establishment

1. Get current server HLC
2. Sync current state of data tables via Electric SQL
3. Merge client's last_synced_clock to current server HLC
4. This establishes a clean starting point without historical action records

## 7. Security & Data Privacy

### Row-Level Security

1. PostgreSQL RLS ensures users only access authorized rows
2. RLS filters action_records and action_modified_rows
3. Replayed actions only affect visible data

### Patch Verification

1. Verify reverse patches don't modify unauthorized rows:
   - Run a PL/pgSQL function with user's permission level
   - Check existence of all rows in reverse patch set
   - RLS will filter unauthorized rows
   - If any rows are missing, patches contain unauthorized modifications
   - Return error for unauthorized patches

### Patch Format

1. JSON Patch Structure:
   - Forward patches follow the simple format `{column_name: value}`. We only need to know the final value of any modified columns.
   - Reverse patches use the same format but represent inverse operations. We only need to know the previous value of any modified columns.
   - action_modified_rows includes an `operation` column "INSERT" | "DELETE" | "UDPATE" to capture adding/deleting/updating as the type of the overall operation against a row.
     - If a row is updated and then deleted in the same transaction the action_modified_rows entry should have operation DELETE and the reverse patches should contain the original value (not the value from the update operation) of all the columns.
     - If a row is inserted and then deleted in the same transaction the action_modified_row should be deleted because it is as if the row were never created
     - If a row is updated more than once in a transaction the reverse patches must always contain the original values
     - Reverse patches must always contain the necessary patches to restore a row to the exact state it was in before the transaction started
   - Complex data types are serialized as JSON
   - Relationships are represented by references to primary keys

### Private Data Protection

1. SYNC actions handle differences due to private data:
   - Created when applying incoming actions produces different results
   - Not created during reconciliation (new action records are created instead)
2. Row-level security prevents exposure of private data
3. Proper action scoping prevents unintended modifications

## 8. Edge Cases & Solutions

### Case: Cross-Client Private Data

**Q: Do we need server-side action execution?**  
A: No. Each client fully captures all relevant changes to data they can access.

**Example:**

1. Client B takes an action on shared data AND private data
2. Client B syncs this action without conflict
3. Client A takes an offline action modifying shared data
4. Client A detects conflict, rolls back to common ancestor
5. Client A records rollback and replays actions (can only see shared data)
6. Client A syncs the rollback and potentially a SYNC action
7. Client B applies the rollback (affecting both shared and private data)
8. Client B replays actions in total order, restoring both shared and private data

### Case: Unintended Data Modification

**Q: Will replaying actions affect private data?**  
A: Only if actions are improperly scoped. Solution: Always include user ID in WHERE clauses.

**Example:**

- An action defined as "mark all as complete" could affect other users' data
- Proper scoping with `WHERE user_id = current_user_id` prevents this
- Always capture user context in action arguments

### Case: Data Privacy Concerns

**Q: Will private data be exposed?**  
A: No. Row-level security on action_modified_rows prevents seeing patches to private data, and SYNC actions handle conditional modifications.

## 9. Storage Management

1. **Unbounded Growth Prevention**:

   - Drop action records older than 1 week
   - Clients that sync after records are dropped will:
     - Replay state against latest row versions
     - Skip rollback/replay of historical actions
     - Still preserve user intent in most cases

2. **Delete Handling**:
   - Flag rows as deleted instead of removing them
   - Other clients may have pending operations against deleted rows
   - Eventual garbage collection after synchronization

### Business Logic Separation

1. Actions implement pure business logic, similar to API endpoints
2. They should be independent of CRDT/sync concerns
3. Actions operate on whatever state exists when they run
4. The same action may produce different results when replayed if state has changed
5. Actions should properly scope queries with user context to prevent unintended data modification

### Action Definition Structure

1. **Action Interface**:

   - Each action must have a unique tag identifier
   - Must include an apply function that takes serializable arguments
   - Apply function must return an Effect that modifies database state
   - All non-deterministic inputs must be passed as arguments
   - A timestamp is always provided as an argument to the apply function to avoid time based non-determinism

2. **Action Registration**:
   - Actions are registered in a global registry (provided via an Effect service)
   - Registry maps tags to implementations
   - Support for looking up actions by tag during replay

## 11. Error Handling & Recovery

1. **Action Execution Failures**:

   - Rollback transaction on error
   - Log detailed error information
   - Provide retry mechanism with exponential backoff
   - Handle specific error types differently (network vs. validation)

## 13. Testing

### Test setup

- Use separate in-memory pglite instances to simulate multiple clients and a server
- Use effect layers to provide separate instances of all services to each test client and server
- Use a mock network service to synchronize data between test clients and fake server
- Use Effect's TestClock API to simulate clock conflict scenarios and control ordering of actions

### Important test cases

    1. Database function tests
       1. Triggers always capture reverse patches that can recreate state at transaction start regardless of how many modifications are made and in what order
    2. Clock tests
       1. Proper ordering of clocks with vector components
       2. Clock conflict resolution for concurrent modifications
       3. Causality detection between related actions
       4. Client ID tiebreakers when timestamps and vectors are equal
    3. Action sync tests
       1. No local actions, apply remote actions with identical patches - no SYNC recorded
       2. No local actions, apply remote actions with different patches - SYNC recorded
       3. SYNC action applied directly to state via forward patches
       4. Rollback action correctly rolls back all state exactly to common ancestor
       5. After rollback actions are applied in total order
       6. Server applies actions as forward patches only (with the exception of rollback which is handled the same way as the client does, find the earliest target state in any rollbacks, roll back to that, then apply patches in total order)
       7. Server rejects actions that are older than other actions modifying the same rows (client must resolve conflict)
       8. SYNC actions correctly handle conditionals in action functions to arrive at consistent state across clients
       9. Concurrent modifications by different clients are properly ordered
    4. Security tests
       1. Row-level security prevents seeing private data
       2. Row-level security prevents seeing patches to private data
       3.

# Update 1

Revised the plan to alter the approach to rollbacks and action_modified_rows generation.

### Rollback changes

1.  Previous approach: record rollback action with all patches to roll back to a common ancestor then replay actions as _new_ actions.
2.  New approach: Rollback action does not record patches, only the target action id to roll back to. Replay does not create new actions or patches. Instead, replay uses the same apply + SYNC action logic as the fast-forward case.

### Server changes:

1.  Previous approach: Server only applies forward patches. This included rollbacks as forward patches. This caused problems because rollbacks contained patches to state that only existed on the client at the time and would not exist on the server until after the rollback when the actions were applied. It also greatly increased the size of the patch set.
2.  New approach: Server handles rollbacks the same way as the client. Analyze incoming actions, find the rollback (if any) that has the oldest target state. Roll back to that state then apply forward patches for actions in total order skipping any rollbacks.

### Action_modified_rows changes:

1.  Previous approach: only one action_modified_row per row modified in an action. Multiple modifications to the same row were merged into a single action_modified_row.
2.  New approach: every modification to a row is recorded as a separate action_modified_row with an incremented sequence number. This allows us to sidestep potential constraint issues and ensure that application of forward patches is capturing the correct state on the server.

## 14. Future Enhancements

1. ESLint plugin to detect impure action functions
2. Purity testing by replay:
   - Make a savepoint
   - Apply an action
   - Roll back to savepoint
   - Apply action again
   - Ensure both runs produce identical results
3. Helper functions for standardizing user context in actions
4. Schema migration handling for action definitions
5. Versioning strategy for the overall system
6. Include clock drift detection with configurable maximum allowable drift
7. Add support for manual conflict resolution
8. Versioning convention for tags (e.g., 'action_name_v1')
9. Optimize vector clock size by pruning entries for inactive clients

### Performance Optimization

1. **Patch Size Reduction**:

   - Compress patches for large data sets
   - Use differential encoding for similar patches
   - Batch small changes into single patches

2. **Sync Efficiency**:

   - Prioritize syncing frequently accessed data
   - Use incremental sync for large datasets
   - Implement connection quality-aware sync strategies
   - Optimize vector clock comparison for large action sets
   - Prune vector clock entries that are no longer relevant

3. **Storage Optimization**:
   - Implement efficient garbage collection
   - Use column-level patching for large tables
   - Optimize index usage for action queries
   - Compress vector clocks for storage efficiency
