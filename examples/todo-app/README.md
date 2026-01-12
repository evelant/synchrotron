# Todo example

TodoMVC-style demo app for Synchrotron (ElectricSQL + Effect + PGlite).

## Setup

From the repo root:

```shell
pnpm install
pnpm run -r build
```

Then:

```shell
cd examples/todo-app
```

Start the Docker services (Postgres + Electric) and initialize the database schema:

```shell
pnpm backend:up
```

This runs `pnpm db:migrate`, which uses `src/db/migrate.ts` to run Synchrotron's server-side schema initialization (`action_records`, `action_modified_rows`, and the app's `todos` table).

Now start the frontend + Bun backend:

```shell
pnpm dev
```

When you're done, stop the backend services using:

```shell
pnpm backend:down
```
