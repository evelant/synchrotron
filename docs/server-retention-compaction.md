# Server retention / compaction

Synchrotron’s `action_records` / `action_modified_rows` log grows without bound unless the server periodically deletes older history.
This doc describes the intended server-side retention/compaction strategy and how clients recover when they are offline long enough to miss pruned history.

## Goals

- Keep server storage bounded (e.g. retain ~14 days of action log history).
- Allow clients that are “too far behind” to recover automatically via `hardResync()` / `rebase()`.
- Avoid permanent “stuck client can never sync again” failure modes.

## Protocol signals used by clients

The server returns two pieces of metadata with sync RPC responses:

- `serverEpoch` (a UUID string): a server “history generation token” stored in `sync_server_meta.server_epoch`.
  - This should change only on hard discontinuities (DB restore/reset, breaking migration that invalidates replay semantics).
  - Clients persist it in `client_sync_status.server_epoch` and treat changes as a hard discontinuity.
- `minRetainedServerIngestId` (number): the earliest `action_records.server_ingest_id` still present on the server.
  - If a client’s cursor is older than this, the server cannot serve an incremental delta.

## Client recovery behavior

When `performSync()` detects a history discontinuity:

- If there are no pending local actions: `hardResync()` then retry once.
- If there are pending local actions: `rebase()` then retry once.
- If there are quarantined local actions (`local_quarantined_actions` non-empty): the client fails and requires app/user intervention (discard quarantined work or hard resync), to avoid silent data loss.

## Proposed server compaction strategy

At a high level:

1. Keep the canonical base tables materialized as usual (rollback+replay on late arrivals).
2. Periodically delete old action log rows from `action_records`.
   - `action_modified_rows` has `ON DELETE CASCADE`, so deleting `action_records` deletes patches automatically.
3. Continue serving bootstrap snapshots so late clients can recover.

## Configuration (server)

Enable automatic time-based compaction by setting:

- `SYNC_ACTION_LOG_RETENTION` (duration string, e.g. `"14 days"`, `"2 weeks"`)

Optional:

- `SYNC_ACTION_LOG_COMPACTION_INTERVAL` (duration string, default: `"1 hour"`)

Compaction uses the server-written `action_records.server_ingested_at` timestamp (trusted server time), not client-provided clocks.

### Choosing a cutoff

There are multiple workable approaches:

- Time-based retention (recommended): delete actions older than some duration.
  - Prefer a server-written timestamp (e.g. `server_ingested_at`) if you don’t want to trust client-provided clocks.
- Count-based retention: keep only the most recent N actions (simple, but not time-based).

### Example SQL (Postgres)

Delete actions older than 14 days (using server time):

```sql
DELETE FROM action_records
WHERE server_ingested_at < NOW() - INTERVAL '14 days';
```

Or keep the newest N by `server_ingest_id`:

```sql
WITH head AS (
  SELECT COALESCE(MAX(server_ingest_id), 0) AS max_id
  FROM action_records
)
DELETE FROM action_records
WHERE server_ingest_id < (SELECT GREATEST(max_id - 100000, 0) FROM head);
```

## When to bump `server_epoch`

Normal retention/compaction should **not** change `server_epoch`.

Bump `sync_server_meta.server_epoch` only when the server history is discontinuous or incompatible, such as:

- Restoring the DB from backup where history diverges from what clients previously observed.
- Resetting the sync log / rebuilding tables in a way that invalidates replay semantics.
- A breaking migration that changes interpretation of action/patch history.
