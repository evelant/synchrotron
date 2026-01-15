# Todo example (Web + PGlite)

TodoMVC-style demo app for Synchrotron (ElectricSQL + Effect + PGlite).

## Setup

From the repo root:

```shell
pnpm install
pnpm run -r build
```

## Run backend (shared)

`pnpm dev` will start the shared backend (Postgres + Electric + Bun RPC server) automatically.

If you want to run it manually, use:

```shell
pnpm dev:backend
```

## Run the web app

Then:

```shell
cd examples/todo-app-web-pglite
```

Now start the app:

```shell
pnpm dev
```

This runs a Bun-based dev setup on http://localhost:5173:

- `bun build --watch ./index.html --outdir dist` (builds the browser bundle)
- `bun server.ts` (serves `dist/` and the PGlite runtime assets over HTTP)

Note: Bun's HTML-import dev server currently rewrites `new URL("./pglite.wasm", import.meta.url)`-style references inside some dependencies to `file://...` URLs in the browser bundle, which browsers refuse to load. Serving the `bun build` output avoids that and keeps PGlite's WASM/data loads on HTTP.

To produce a static build in `dist/`:

```shell
pnpm build
```

When you're done, stop the backend services using:

```shell
pnpm docker:down
```
