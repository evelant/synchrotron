# @effect/sql-pglite

An [@effect/sql](https://github.com/Effect-TS/effect) driver implementation for [PGlite](https://pglite.dev/).

## Browser note (multiple instances)

Some bundlers / setups can trigger a PGlite WASM loader edge-case when creating multiple PGlite instances in the same page (e.g. a multi-client demo), producing:

`Cannot compile WebAssembly.Module from an already read Response`

As a workaround, this driver will (in browser runtimes) prefetch + compile `/pglite.wasm` once and pass the resulting `wasmModule` into `PGlite.create()` when you haven’t provided one yourself.

If your app serves the PGlite runtime assets from a different URL, pass `wasmModule` explicitly (or make `/pglite.wasm` available).
