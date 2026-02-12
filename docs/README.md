# Synchrotron docs

This folder contains developer-facing documentation for Synchrotron.

## Where to start

- Repo overview: `../README.md`
- System design (architecture + invariants): `../DESIGN.md`
- Using Synchrotron in an app (client setup, actions, schema rules): `./usage.md`
- Transports (RPC polling, Electric ingress, custom ingress): `./transports.md`

## Topics

- Bootstrap snapshots: `./bootstrap.md`
- Security model (RLS + auth): `./security.md`
- Shared rows (`audience_key`): `./shared-rows.md`
- Server retention / compaction + client recovery: `./server-retention-compaction.md`
- Testing (E2E harness + patterns): `./testing/e2e.md`

## Notes

- This repo carries pnpm patches for some upstream packages (see `../patches/` and `../package.json`).
- `./planning/*` contains historical design/implementation notes. Some docs are still useful, but treat them
  as “working notes”, not the canonical spec.
- `./vendor/*` contains Effect-related notes we’ve found useful while building Synchrotron.
