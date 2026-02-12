# Synchrotron

Offline-first fully-multiplayer sync for Postgres for _any_ app with no conflict resolution code. Synchrotron always converges correctly for _your app's rules_ even when data is shared between users or private to certain users. The end result is as if everything offline had happened in real time against a traditional central API.

How is that possible if Synchrotron doesn't know your app's business rules, multiple users can mutate the same data offline, some data is invisible to some users, and you don't write special code to handle conflicts?

Synchrotron records **actions** (your mutation functions + arguments) rather than row-level patches. When clients diverge, they roll back to a common ancestor state then replay actions in a global order. Even if two clients edit the same piece of data offline when they sync _your app's logic runs in the order the actions were originally taken_. The final state never breaks your app's rules without requiring any conflict resolution code.

This is in contrast to most existing offline-first solutions which only track and merge data. Merging data doesn't know anything about the meaning of the data, so most solutions will happily merge data into states that are completely invalid for your app, leaving you to write special case-by-case code to fix it.

Runs on the web and React Native (iOS and Android). Comes with OpenTelemetry instrumentation. Client database can be [PGlite](https://pglite.dev/) (Postgres-in-WASM) or SQLite.

Built with [Effect](https://effect.website/).

## Status

**Experimental, but complete** — Not used in production yet but it is fully featured, has a robust test suite, and has example apps for all platforms.

## Examples

This repo includes end-to-end examples:

- **Shared backend**: `examples/backend` (Postgres + [Electric-sql](https://electric-sql.com/) + Bun server).
  - `pnpm docker:up` (requires Docker)
  - `pnpm dev:backend`
  - Includes a local OpenTelemetry dev backend: Grafana LGTM stack with example dashboards on http://localhost:3001.
- **Web + PGlite**: `examples/todo-app-web-pglite`
  - Built-in “two clients” harness with transport toggle (RPC polling vs Electric ingress) and online/offline toggle.
  - `pnpm dev:web` → open http://localhost:5173
- **React Native + SQLite (+ Web)**: `examples/todo-app-react-native-sqlite`
  - `pnpm dev:react-native`

Each example has its own README with setup and architecture notes.

## Documentation

Start here:

- Docs index: `docs/README.md`
- App integration guide: `docs/usage.md`
- Transports (ingress/egress): `docs/transports.md`
- System design (algorithm + invariants): `DESIGN.md`

Related topics:

- Bootstrap snapshots: `docs/bootstrap.md`
- Security model (RLS + auth): `docs/security.md`
- Shared rows (`audience_key`): `docs/shared-rows.md`
- Server retention/compaction: `docs/server-retention-compaction.md`
- Testing (E2E): `docs/testing/e2e.md`

## Packages

- `packages/sync-core`: core algorithm + DB contract (schema, patch capture, apply/reconcile).
- `packages/sync-client`: client DB layers (PGlite, SQLite), RPC transport, and optional ingress transports (Electric).
- `packages/sync-server`: RPC server + server-side materialization + snapshots + auth.
- `packages/observability`: optional OpenTelemetry layers used by examples.
- `packages/sql-pglite`: `@effect/sql` driver for PGlite (upstream candidate).

## Development

- Install: `pnpm install`
- Build: `pnpm run -r build`
- Format: `pnpm format`
- Lint: `pnpm lint`
- Test: `pnpm test`

Note: `packages/sql-pglite` is intentionally excluded from repo-wide checks (upstream candidate with separate requirements).

## License

MIT
