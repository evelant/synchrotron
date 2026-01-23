# Bootstrap snapshots

Synchrotron can “fast bootstrap” an empty client by hydrating application tables from the server’s canonical state and advancing the remote fetch cursor to the snapshot head. This avoids replaying the full action log.

## When it runs

The client (`SyncService.performSync`) uses a bootstrap snapshot when:

- `client_sync_status.last_seen_server_ingest_id === 0`, and
- local `action_records` is empty

The snapshot is applied with patch tracking disabled (no patch-capture triggers, no local action log entries).

## RPC transport

The RPC server exposes `FetchBootstrapSnapshot`, returning:

- `serverIngestId`: current head `action_records.server_ingest_id` (RLS-filtered)
- `serverClock`: server HLC at snapshot time
- `tables`: `{ tableName, rows[] }` for configured tables

After applying the snapshot, the client resets `client_sync_status` from the snapshot metadata (including `last_seen_server_ingest_id = serverIngestId` and using `serverClock` as the new clock baseline), then continues normal incremental sync (`FetchRemoteActions` from that cursor onward).

If the server is not configured for snapshots, the client falls back to “action-log restore” via `includeSelf=true` on the first fetch (works, but scales with history).

## Server configuration

Provide `SyncSnapshotConfig` on the server and list the tables you want to snapshot:

```ts
import { createSyncSnapshotConfig } from "@synchrotron/sync-server/SyncSnapshotConfig"
import { Layer } from "effect"

const ServerLayer = Layer.mergeAll(
  /* your DB + RPC layers */,
  createSyncSnapshotConfig(["projects", "notes"])
)
```

Notes:

- Tables are fetched/applied in the order listed. If you snapshot multiple tables with foreign keys, list parent tables first.
- Snapshot reads run under normal RLS (`synchrotron.user_id`), so each user only receives rows they can see.
