# Baseline (Phase A)

Recorded: 2026-10-30, Windows x64, Node v24.18.0, Rust 1.99.0.

Fork point: Rusteerio `af21a24cc14c1fac870405b276ae7514a8c80dfd` (v2.0.0),
renamed to `cheerox` (package name, binding name `cheerox.<platform>.node`,
`CHEEROX_THREADS` env var with `RUSTEERIO_THREADS` kept as fallback).
Internal `Symbol.for('rusteerio.*')` protocol keys are unchanged (TS↔Rust
matched pair; invisible to users).

## Baseline test results (after rename)

| Suite | Command | Result |
| --- | --- | --- |
| Runtime & release checks | `npm test` (node --test) | **513 pass / 0 fail** |
| Cheerio 1.2.0 upstream suite | `npm run test:upstream` (vitest) | **777 pass / 0 fail** (14 files) |
| Rust engine tests | `cargo test` | **57 pass / 0 fail** |

Rename changes required to keep the fork's own tests green:

- `scripts/*` and `test/release-guard.test.mjs`: package/repo name expectations.
- `test/module-interop.test.mjs`: native binary filename filter
  (`cheerox.*.node`).
- `test/native-workers.test.mjs`: env var name (`CHEEROX_THREADS`).

## What the baseline gives us

The fork already passes the complete Cheerio 1.2.0 upstream suite (777 tests)
against the Rust engine. Architecture:

- Native arena DOM (`native/src/arena.rs`), htmlparser2-style tokenizer
  (`native/src/tokenizer.rs`), native selector engine (`native/src/selector.rs`),
  native serialization, mutations, clone, import/export.
- TypeScript facade: `src/index.ts` (modern load/createAPI/statics),
  `src/selection.ts` (Cheerio 1.x class), `src/nodes.ts` (lazy node views with
  writable fields + attribute proxy), `src/router.ts` (document state),
  `src/slim.ts` (htmlparser2-style entry: `_useHtmlParser2: true,
  isDocument: false`).
- Modern extras: `loadAsync`, `loadAll`, `extractAll`, `configureWorkers`,
  `workerPoolInfo`, streams/HTTP IO.

Legacy (0.22.0) mode will reuse the native engine and node views, with a
0.22.0-shaped facade as the default entry point.
