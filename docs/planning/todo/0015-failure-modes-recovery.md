# 0015 — Failure modes + recovery (no stuck clients)

## Status

In progress (partial)

- Implemented: explicit resync primitives + tests (`SyncService.hardResync()` + `SyncService.rebase()`)
- Implemented: typed `SendLocalActions*` failures over RPC + bounded `BehindHead` retry in `performSync()`
- Remaining: discontinuity detection + unsyncable local work recovery + other “stuck” tests

## Goal

Ensure a client cannot become **permanently unable to sync** (assuming the network recovers and the user’s credentials are valid), by defining:

- a concrete **failure-mode inventory**
- explicit **recovery behaviors** (automatic where safe, user/app-driven where not)
- two explicit resync primitives with tests:
  - **hard resync** (discard everything + refetch all state)
  - **soft resync / rebase** (keep pending local actions, refetch all state, then replay pending actions)

## Definition: “stuck”

A client is “stuck” if repeated `performSync()` calls:

- never reduce the set of **pending local actions** (`synced = 0`), and
- never advance the client’s **applied remote watermark** (`client_sync_status.last_seen_server_ingest_id`),

even though:

- remote ingress is available (RPC/Electric), and
- the client can authenticate, and
- the server is healthy.

## Current behavior (summary)

- `performSync()` does: optional bootstrap snapshot → remote ingress → apply remote → send local.
- Upload failures from the server are typed (at least for `SendLocalActions*`) and propagate to the client.
- `performSync()` treats `SendLocalActionsBehindHead` as a transient control signal and does a small bounded retry (fetch → apply → retry upload). If contention persists, it surfaces `SendLocalActionsBehindHead` to the app.
- Some scenarios can create “forever failing” uploads (e.g. permission revocation) unless the client/app chooses a recovery policy (quarantine, rollback, hard resync).

## Failure-mode inventory

### 1) Upload blocked by auth / RLS / membership churn

**Example:** user executes local actions for an audience they later lose access to. Server rejects `action_records`/`action_modified_rows` inserts (RLS `WITH CHECK`).

**Why this can brick a client:** pending actions remain forever; every sync attempt retries the same upload and fails.

**Desired outcome:** client either (a) auto-resolves by discarding/rolling back unsendable local work, or (b) quarantines it and continues syncing other audiences.

### 2) Upload blocked by schema drift / constraints

**Example:** local action produces patches that violate server-side constraints (NOT NULL/FK) under canonical rollback+replay order.

**Desired outcome:** same as (1), but with clearer diagnostics and an escape hatch (hard resync and/or user intervention).

### 3) Head-gate conflict loops (basis cursor churn)

**Example:** server receives a visible remote action between client fetch and client upload; server rejects upload as “behind head”.

**Why this can be sticky:** if the client is in sustained write contention (many other writers), it may struggle to find a “quiet window” where it can upload at head. Tight retry loops can also waste CPU/network.

**Desired outcome:** treat “behind head” as a control signal: fetch → apply → retry upload with backoff. If it persists, surface a typed “try again later” signal to the app (no resync/rebase will help if head never stops moving).

### 4) Remote history discontinuity (server reset / retention / snapshot-only)

**Example:** server loses/prunes parts of sync history required to incrementally catch up (retention / compaction), or is reset/restored.

**Desired outcome:** client detects discontinuity and triggers:

- **soft resync / rebase** if it has pending local actions worth preserving, else
- **hard resync** if it can safely discard local state.

### 5) Local state loss or corruption (partial wipe)

**Example:** base tables are empty/corrupt but `client_sync_status.last_seen_server_ingest_id > 0`, so bootstrap won’t run and incremental fetch won’t restore state.

**Desired outcome:** local invariant checks detect the mismatch and trigger hard resync.

### 6) Ingress mid-flight (action_records arrive without action_modified_rows)

**Example:** Electric/transport writes `action_records` first and AMRs later.

**Current behavior:** `performSync()` bails out early to avoid generating spurious outgoing CORRECTION deltas.

**Desired outcome:** bounded “wait for patches” retry/backoff and clear logging so it doesn’t look like a hang.

## Proposed core improvements (TODO)

### A) Typed error classification from server → client

Stop forcing the client to string-match errors.

Add explicit “reason codes” for upload failures, at least:

- `BehindHead` (include first unseen server ingest id)
- `UploadDenied` (RLS/policy)
- `UploadInvalid` (schema/constraint/serialization)
- `SinceTooOld` / `EpochMismatch` (history discontinuity)

Implemented (partial):

- `SendLocalActions` now returns typed failures over RPC:
  - `SendLocalActionsBehindHead` (includes basis + first unseen ingest id)
  - `SendLocalActionsDenied`
  - `SendLocalActionsInvalid`
  - `SendLocalActionsInternal`

### B) Backoff retry for head-gate conflicts (not a “hard” failure)

When upload fails with `BehindHead`, the correct recovery is usually just “retry after fetching/applying the newly-visible remote actions”.

Proposed behavior:

1. fetch remote actions
2. apply remote actions
3. advance applied watermark
4. retry upload using a backoff `Schedule` (fibonacci/exponential + jitter)

Notes:

- There is no meaningful “fallback” after repeated `BehindHead` besides waiting/retrying. If contention is high enough that the client can’t ever be at head at upload time, the system is operating outside the intended envelope (Synchrotron is not designed for high write contention across many writers).
- Avoid infinite busy-loops inside a single `performSync()` call. Either:
  - do a small number of immediate retries (to cover the common race), then return a typed `BehindHead`/`RetryLater`, or
  - expose a separate “sync loop” helper that the app runs in the background with a `Schedule`.

Implemented:

- `SyncService.performSync()` retries `SendLocalActionsBehindHead` a small number of times (immediate retry; see `packages/sync-core/src/SyncService.ts`).
- Test coverage: `packages/sync-core/test/sync/behind-head-retry.test.ts`

### C) “Unsyncable local work” handling (prevent permanent bricks)

When upload fails with `UploadDenied` (or a clearly non-recoverable `UploadInvalid`):

Options (pick one; document behavior):

1. **Auto-rollback + delete** the smallest suffix of pending actions that cannot be uploaded.
2. **Quarantine** those actions (new local status + UI hook), and continue syncing other audiences.
3. Surface a deterministic “needs user intervention” error + an explicit `hardResync()` action.

### D) Resync primitives (hard + rebase)

Add explicit client operations that make forward progress always possible:

Implemented:

- `SyncService.hardResync()` and `SyncService.rebase()` (see `packages/sync-core/src/SyncService.ts`)
- Tests in `packages/sync-core/test/sync/resync.test.ts`

#### D1) “Hard resync” (discard everything)

Add a client operation that:

- clears sync tables (`action_records`, `action_modified_rows`, `local_applied_action_ids`)
- resets `client_sync_status` watermark and clocks from server snapshot metadata
- rehydrates base tables from `FetchBootstrapSnapshot`

This should be callable automatically (for epoch discontinuity) and manually.

#### D2) “Soft resync” / “Rebase” (keep pending local actions)

This is a recovery operation for when the client cannot incrementally catch up (e.g. server-side action log compaction) but the user still has local pending work.

High-level behavior:

1. **Extract pending local actions** (`action_records.synced = 0`) as an ordered list of `{ id, _tag, args, transaction_id, clock }`.
2. **Reset local state** to match the server:
   - clear base tables
   - delete all synced action log rows and any derived state (`action_modified_rows`, `local_applied_action_ids`, etc)
   - reset `client_sync_status` from snapshot metadata (watermark/clocks)
3. **Bootstrap** from `FetchBootstrapSnapshot` (now the client is “at head” again).
4. **Re-run the pending local actions** on top of the fresh snapshot (in their original order) so their patches/AMRs are regenerated against the new base.

Decision / implementation approach:

- **Preserve action ids (recommended):** keep the existing `action_records.id` for pending actions and re-run them (recapturing patches) against the refreshed base. This avoids having to rewrite any args and keeps any `DeterministicId`-generated row IDs stable.
- **Re-record as brand new actions (not supported by default):** create new `action_records` for each pending action and run them again. This only works if args don’t reference `DeterministicId`-generated row IDs (or you implement ID remapping + arg rewriting).

Concrete example (why new action ids can break a naive “re-record”):

- Pending action A: `test-create-note` (see `packages/sync-core/test/helpers/TestHelpers.ts`) does _not_ take a note id in args; it generates the inserted note id via `deterministicId.forRow(...)` (namespaced by the action id).
- Pending action B: `test-update-content` takes `{ id: noteId, ... }` in args.
- If rebase “re-records” A as a new action with a new id, the created note id changes. B’s args still reference the old note id, so the update becomes a no-op (or fails), even though we re-ran the actions in order.

This problem does _not_ exist if “create” actions take explicit row ids in args (e.g. `test-create-note-with-id`). 5) Attempt `performSync()` again (including normal “behind head” bounded retry).

If a pending action cannot be replayed (missing action creator, non-pure action, etc), the client should fall back to either:

- quarantining that action (and continuing with the rest), or
- hard resync + surfacing a “local changes discarded” decision to the app.

### E) Local invariants / self-healing (“sync doctor”)

Add a cheap check (run at start of `performSync()` or on error) to detect:

- cursor/state mismatch (e.g. watermark > 0 but no local base data)
- orphaned `action_modified_rows` / missing patches
- invalid clock shapes per dialect

If violated, recommend or trigger hard resync.

## Test plan

Add tests that prove “no permanent stuck” behaviors:

- **BehindHead retry:** inject an interleaving remote action between fetch and send; `performSync()` eventually uploads. (Implemented)
- **RLS deny recovery:** revoke membership after local pending actions; client resolves (auto-rollback/quarantine) and sync proceeds.
- **Epoch mismatch / history discontinuity:** server reset (or simulated `SinceTooOld`) forces hard resync.
- **Partial wipe:** clear base tables or action log while keeping cursor; invariant triggers hard resync.
- **Compaction rebase:** simulate `SinceTooOld` with pending local actions; client rebases (keeps pending actions) and eventually uploads.
