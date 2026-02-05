# 0019 — Stable row IDs under divergent content

## Status

Implemented (identity config + guardrails + integration tests)

## Summary

Synchrotron generates deterministic row ids in TypeScript via `DeterministicId.forRow(tableName, seed)`
(UUIDv5 scoped to the current `action_record_id`). This is necessary so replay can create the _same_
primary keys across client DBs.

We also support divergence where replay can produce different **row values** due to private/conditional
logic, and we converge via CORRECTION deltas.

This doc focuses on one narrow issue:

> How do we keep row ids stable even when replicas may compute different non-identity column values for
> what is logically “the same row”?

We intentionally _do not_ cover “replay creates extra/new rows on non-originating clients” here; that’s
tracked separately in TODO `0020`.

## Background (current behavior)

- `DeterministicId.forRow(tableName, seed)` computes UUIDv5 from:
  - the current `action_record_id` (namespace when it is a UUID, otherwise included in the name),
  - the `tableName`,
  - a canonical JSON string of `seed` (keys sorted; `undefined` omitted; `Date` → ISO; etc).
    See `packages/sync-core/src/DeterministicId.ts`.
- The name “forRow” is potentially misleading: callers can (and currently do) pass full row content
  snapshots as `seed`.

### Identity config (implemented)

`DeterministicIdIdentityConfig` allows apps to define (once per table) how identity is derived for ID
generation:

- `identityByTable[tableName] = ["colA", "colB"]` (stable identity columns), or
- `identityByTable[tableName] = (row) => ({ ... })` (custom identity projection).
- With an identity strategy, `forRow` hashes only the identity seed (not full row content).
- `forRow` fails if a table has no configured identity strategy.

Unit coverage lives alongside `packages/sync-core/test/DeterministicId.test.ts`.

Integration coverage:

- `packages/sync-core/test/sync/stable-row-ids-under-divergent-content.test.ts`
- `packages/sync-core/test/sync/stable-row-ids-under-divergent-content.sqlite.test.ts`

## The problem

If the `seed` passed to `forRow` includes mutable/view-dependent values (e.g. `content`, `updated_at`,
or any value derived from private state), then two replicas can legitimately compute different seeds and
thus different row ids for what the application considers “the same entity”.

That breaks the action log’s referential consistency:

- later actions that reference “the entity id” won’t line up across replicas,
- duplicates or no-ops appear,
- convergence becomes ill-defined (CORRECTION operates on concrete `(table,row_id)` patches).

### Collisions are not disambiguated

`forRow` is intentionally a pure function of `(actionId, tableName, seed)`. If you need to create multiple
rows within one action, you must include an explicit stable disambiguator in the identity seed (for example
a `<table>_key` column passed in action args).

Attempting to insert two rows with the same computed id should fail fast via the table’s primary-key
constraint (and should be treated as a bug in the action’s identity modeling).

## Design direction (proposed constraints)

### A) Treat the `seed` as an identity key, not as row content

The `seed` object should represent a stable **identity key** for the entity:

- stable for the row’s logical lifetime,
- excludes values that are expected to vary across replicas/views,
- ideally includes a stable scope token (e.g. `audience_key` in the shared-row model).

### B) Make identity keys globally unique within their scope

Identity keys must be unique within their scope. If a collision is possible, the identity design is
underspecified.

If we truly need multiple “same-shaped” rows created by one action, include an explicit stable
ordinal/key in the identity seed.

### C) Prefer “logical keys” over “row snapshots”

Examples of identity keys (table-specific):

- `notes`: `{ audience_key, note_key }` (where `note_key` is stable and unique within the audience)
- `comments`: `{ audience_key, note_id, comment_key }`
- `membership`: `{ audience_key, user_id }`

Non-examples (should not be in identity keys):

- timestamps (`created_at`, `updated_at`)
- content fields that can differ by view (`content`, `title`)
- derived/aggregated values

## Candidate approaches (brainstorm)

### 1) Identity-key seeds (most direct fix)

Keep the “hash-based” property, but change _what_ gets hashed: the `seed` is an **identity key**, not a
row snapshot.

- **Data used as input:** `tableName` + canonical JSON of a small identity object (plus current action id
  namespace; optionally include `audience_key` / scope).
- **Intuition:** if two replicas disagree on `title` but agree on “which entity this is”, they should still
  compute the same row id.

Example (shared row whose `title` can differ by view):

- Table: `notes(id, audience_key, note_key, title, created_at, ...)`
- Action args: `{ audience_key, note_key, title, timestamp }`  
  (where `note_key` is a client-generated UUID created _outside_ the action and passed in as an arg)
- Action code on all replicas:
  - `noteId = forRow("notes", { audience_key, note_key })`
  - insert `{ id: noteId, audience_key, note_key, title, created_at: timestamp, ... }`

Now if some replica replays the action but derives a different `title` due to private state, the `noteId`
is unchanged because `title` wasn’t part of the identity seed. Divergent content becomes a normal
CORRECTION update to the same `(table,row_id)`, instead of creating a second row.

This has the same “order/count doesn’t matter” benefit as the current full-row hashing _as long as_ the
identity key is unique within its scope.

Practical DX implications for a library:

- The library can’t infer identity keys, so this becomes either:
  - a convention (“always include a stable `<table>_key` column”), or
  - explicit per-table configuration (see approach 2), or
  - a new API that makes intent explicit (`forKey` instead of `forRow`).

### 2) Per-table identity projection / config (better DX, still general)

Instead of forcing callers to manually construct identity seeds at every call site, let apps configure how
identity is derived for each table (once).

- **Data used as input:** `tableName` + canonical JSON of `identity(row)` (plus action id namespace).
- `identity(row)` is an app-provided projection (or list of column names) that returns only stable fields.

Example:

```ts
const identity = {
	notes: (row: any) => ({ audience_key: row.audience_key, note_key: row.note_key }),
	note_members: (row: any) => ({
		audience_key: row.audience_key,
		note_id: row.note_id,
		user_id: row.user_id
	})
}
```

Then `forRow("notes", fullRow)` can internally hash only `identity.notes(fullRow)`, so the dev ergonomics
of “pass the whole insert object” stays, while the id no longer depends on mutable/view-dependent columns.

This also makes it easier to add diagnostics:

- warn if identity projection returns `null`/`undefined` fields,
- warn if identity projection yields duplicates within one action (i.e. two inserts would compute the same id),
- enforce “identity must include `audience_key` for shared tables” (optional).

### 3) Replay-time “origin id binding” (replay becomes id-authoritative)

When **applying** a remote action, we already know the row ids that the origin used for INSERTs (they’re
in the incoming `action_modified_rows`). We can reuse those ids during replay instead of re-deriving them
from local seeds.

- **Data used as input (on apply):** the incoming patch set itself: `(table_name, operation=INSERT, row_id)`
  ordered by `sequence`.
- **Mechanism:** during `withActionContext(actionId, ...)`, install an “id allocation plan” so calls to
  `forRow(table)` return the next expected origin `row_id` for that table (or globally by sequence),
  ignoring the local `seed` entirely (or using it only for dev-mode consistency checks).

Example (the exact bug we’re worried about):

1. Origin client executes `CreateNote` and inserts into `notes` with id `n1`. The patch log records:
   - `action_modified_rows`: `{ table_name: "notes", operation: "INSERT", row_id: "n1", ... }`
2. Another client replays `CreateNote` but computes a different `title` because it branches on private state.
3. With origin id binding:
   - when the replay calls `forRow("notes", seed)`, it returns `"n1"` (from the incoming patch queue),
     so the INSERT targets the same primary key.
4. Any content differences become CORRECTION patches to row `"n1"`, not a new row with a different id.

Tradeoffs / interactions:

- This is appealing because it makes ids stable even if callers keep passing full row snapshots to `forRow`.
- It couples id allocation to replay behavior and the “shape” of the patch set.
- It interacts directly with TODO `0020`:
  - if replay produces **extra INSERTs**, there is no origin id to bind; we must fall back to local id
    generation and emit a CORRECTION insert (fine).
  - if replay produces **fewer INSERTs** than the incoming patch set, we should treat that as an error or
    an explicitly unsupported pattern (subtractive divergence).
  - if call order differs (different number/order of `forRow` calls vs INSERTs), we need clear constraints
    or diagnostics.

### 4) Documentation-only rule (short term)

Document a hard rule: “`DeterministicId.forRow` must be called with an identity key, not full row
content”. Provide examples and footguns.

### 5) API rename / split (medium term)

Introduce an API that encodes intent:

- `DeterministicId.forKey(tableName, key)` (preferred name)
- keep `forRow` as an alias or deprecate it in docs

### 6) Dev diagnostics (optional)

Opt-in checks that warn when identity seeds include suspicious fields (e.g. `updated_at`) or when
identity keys are underspecified (for example: missing scope tokens for shared tables).

## Test plan ideas

- Positive: two clients replay an action and compute different row values, but because the identity key
  excludes those values they still refer to the same row id.
- Negative: construct an action where the seed includes view-dependent content; show id divergence and
  document as unsupported / diagnostic-worthy.
- Collision: show that inserting two rows with the same computed id fails fast (primary-key violation) and
  should be treated as a bug in the action’s identity modeling.

## Open questions

1. Should we introduce a “per-table identity key config” to guide users, or keep it as convention?
2. Do we want to encode “scope token required” (e.g. `audience_key`) into recommended identity patterns?
3. Should remote apply treat origin INSERT ids as authoritative (approach 3), and if so what constraints do
   we enforce about `forRow` ↔ INSERT correspondence?
