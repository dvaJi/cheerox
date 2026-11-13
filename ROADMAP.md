# cheerox — Performance & Optimization Roadmap

**Goal:** make cheerox the fastest and most memory-efficient implementation
of the Cheerio-compatible API, without requiring any change to existing user
code.

There are now two tracked performance surfaces:

- **Legacy facade vs cheerio@0.22.0** — measured by `bench/legacy.mjs`
  (verified-output timings). The baseline table below is its live record.
- **Modern API vs cheerio@1.2.0** — tracked in
  [bench/PERFORMANCE-PLAN.md](bench/PERFORMANCE-PLAN.md) (paired A/B harness
  in `bench/compare-builds.mjs`, investigation history in
  [bench/PERFORMANCE-INVESTIGATION.md](bench/PERFORMANCE-INVESTIGATION.md)).

Every milestone is gated by the compatibility suites — an optimization that
moves a benchmark but breaks a gate is rejected.

## Guardrails (apply to every milestone)

- **The API is frozen.** `cheerio.load()`, callable module, selector
  signatures, node shapes, chaining — no redesign, no async `load()`.
- **Compatibility gates run on every change:**
  `npm run test:legacy` (577 passing, 0 failing — the suite's
  empty-attribute expectation was corrected toward the pinned oracle, see
  `bench/PERFORMANCE-INVESTIGATION.md`),
  `npm run test:differential` (58/58), `npm test` (532),
  `npm run test:upstream` (777), `cargo test` (60), `npm run test:types`,
  `npm run test:package`, plus the performance gate `npm run bench:gate`
  (parity floors per operation, HTML + XML).
- **Benchmarks verify outputs before timing**; a run with divergent output
  fails instead of reporting a speedup.
- **Significant perf decisions require paired comparisons** (30+ alternating
  rounds with bootstrap intervals, `bench/COMPARE.md`) — single medians are
  diagnostic only.
- Optimize the implementation, not the public API. Per-method tree shaking
  of a native addon is not a realistic goal for a fully compatible drop-in
  replacement.

## Current measured baseline (2026-11-13, legacy facade vs cheerio@0.22.0)

`node --expose-gc bench/legacy.mjs`, median of 5, outputs verified, Windows
x64, Node 24.18.0.

| Workload (vs cheerio@0.22.0) | Ratio | State |
| --- | ---: | --- |
| Parse only (small / large) | 2.08x / 1.97x | ahead |
| Parse + queries (large) | 1.30x | ahead |
| Attribute extraction (real-world) | 1.40x | ahead |
| Text extraction (large) | 1.54x | ahead |
| Serialization (large) | 2.49x | ahead |
| DOM mutations (small / large) | 1.07x / 1.36x | ahead (was 0.24x / 0.28x) |
| Warm re-require + parse + query | 0.97x | parity |

On the modern API vs cheerio@1.2.0 (21-sample run, 2,000-card fixture,
2026-11-12): load 1.79x, 17 of 25 operations above 1.5x total; the rows
still below target are bound by per-node JavaScript materialization
(walk with fields 0.79x, walk children 1.32x, selection chains
1.42–1.46x) — see `bench/PERFORMANCE-PLAN.md`.

## M0 — Compatibility & profiling (keep live)

**Status: exists.** `bench/legacy.mjs` (verified-output timings),
`test/differential/` (58 oracle-compared operations), the legacy suite,
the upstream suite, and the performance gate are wired into CI.

Remaining additions:

- Record **P95 latency**, **peak RSS**, and **V8 heap** alongside medians in
  `bench/legacy.mjs`.
- Add an **installation-size + cold-import** case: packed tarball size,
  `.node` size, `require()` time, ESM import time.
- Add a **memory scaling** case (load 10,000 documents in a loop; track RSS
  growth and GC behavior).
- Keep `docs/BENCHMARK.md` and the paired-run JSON reports as the checked-in
  record per optimization round.

## M1 — Lean packaging (P1, low risk)

**Rust build profile.** Current `[profile.release]`: `lto = "thin"`,
`codegen-units = 1`, `strip = "symbols"` (done).

- Remaining experiment: an `opt-level = "s"` + `lto = "fat"` release-size
  profile; benchmark `.node` size AND runtime before adopting (size-optimized
  code can regress hot loops).
- Avoid `panic = "abort"`: an unexpected Rust panic must not kill the Node
  process.

**JavaScript loading.**

- Audit ESM exports for `sideEffects` accuracy; verify with esbuild/Rollup
  fixtures that bundlers can drop unused internal modules while
  `require('@dvaji/cheerox')` behaves identically.
- Keep I/O, streaming, and worker modules out of the synchronous startup
  path where lazily loading them preserves behavior.

**Platform packaging.**

- Move to NAPI-RS's platform-specific optional packages
  (`@dvaji/cheerox-<platform>-<arch>`) so consumers download one binary
  instead of the universal tarball (~14 MB with eight binaries); keep the
  current single-tarball flow as fallback.
- Track: tarball size, install-time download, cold-import time.

**Targets (provisional, measure before/after):** −20% native binary size,
no runtime regression beyond noise on `bench/legacy.mjs`.

## M2 — Selector engine (P1–P2)

- **A. Bounded eviction — done.** The parsed-selector caches now use a
  two-generation scheme (`PARSED_CURRENT`/`PARSED_PREVIOUS`) instead of
  clear-on-full, so a scraper cycling more selectors than the cap keeps its
  hot set.
- **B. Query planning — first step done.** The immutable parse tree carries a
  tag-name candidate index (`TreeIndex.name_index`). Before extending
  further, profile: id/class candidate indexes only pay off above
  document-size thresholds.
- **C. Compiled-program reuse across documents — open.** The parse cache is
  thread-local; batch workloads (`extractAll` on rayon threads) rebuild
  programs per thread. Consider a shared concurrent cache or seeded caches.
- **Constraints:** DOM mutations, XML case sensitivity, custom pseudos,
  `:scope`/leading combinators, and result ordering must stay byte-identical
  (the legacy pseudo-allowlist and 0.22.0 scoped semantics are enforced in
  the facade and must keep applying).

## M3 — JS↔Rust bridge overhead (P2)

Typed direct NAPI methods exist for `select`, `text`, `attr`/`setAttribute`/
`addClass`, `innerHtml`, `outerHtml`, `render`, `parseAsync`, and batched
`attr(name, fn)` writes cross a selection via one `setAttrs` call.

- **Remaining generic JSON paths:** `setNode` field writes and `traverse`/
  `create` still cross the boundary as JSON. Typed bindings for the
  highest-frequency of these are the next candidate.
- **Return primitives/native arrays directly** instead of JSON strings for
  id lists and attribute reads where not already done.
- **Fuse operations** whose intermediates are not observable from JS — only
  where no callback can interleave.
- **Do not batch across observable side effects:** callbacks in
  `.each()`/`.map()` may mutate the DOM; execution order is part of the
  0.22.0 contract.
- **Per-node view materialization cost** is now the dominant remaining gap on
  the modern API (`walk with fields` 0.79x vs cheerio@1.2 total): the first
  walk materializes a view object plus a live child array per node. Micro
  variants (constructor shapes, cached-getter inlining, object literals,
  omitted symbols) were measured and rejected — see
  `bench/PERFORMANCE-INVESTIGATION.md`. Next candidates: batched
  materialization during load for large documents, or a cheaper attribute
  object, both with full identity/mutation controls.

## M4 — Memory & DOM (P3)

- Reduce short-lived string allocations in hot ops (escape/serialize
  buffers, attribute value copies).
- Reuse selector scratch buffers across queries within a thread.
- Improve detached-node reclamation and first-mutation cost: the engine
  already parses into an immutable tree and copies into the mutable arena on
  first write; more granular copy-on-write is a possible experiment **only
  if** profiling shows the first-write transition is a real bottleneck —
  node identity is observable through the legacy API, so this is the
  highest-risk item here.
- Independent **memory profiling** (heap snapshots, per-object retained
  sizes) to replace the coarse process-RSS observations recorded so far.

## M5 — Parallelism, runtime & deployment (P3–P4)

- Scale `extractAll` further: the known limits are main-thread input copying
  and result conversion; investigate compact native result representations
  and avoiding excess parallelism at high CPU counts.
- Runtime matrix: Node 20/22/24 (already in CI), **Bun** with dedicated
  compatibility tests, Alpine/musl + Linux ARM64 prebuilts (already built —
  add smoke tests), serverless cold-start profiling.
- **WASM/WASI is a later experiment** (P4): native-compatible runtimes are
  not automatically WASI-compatible, and threaded browser execution has
  extra requirements. Node.js performance and legacy compatibility are never
  traded for portability claims.

## Deliberate non-goals

| Idea | Why not |
| --- | --- |
| Per-method native tree shaking | Native addons are compiled artifacts; bundlers cannot strip Rust functions |
| Native iterators replacing selections | Changes observable collection behavior |
| Async `load()` | Breaks the 0.22.0 contract |
| Auto-parallelizing every query | Coordination overhead + possible semantic changes |
| Eagerly materializing all nodes as JS objects | Defeats the native memory design |
| Result caching across mutations | Invalidation is unprovable after arbitrary writes |
| Parser rewrite | Rejected — the html5ever pipeline is now 2.5x faster than at the time this was written (fast whole-tag tokenization, vector-backed attribute storage, vendored crates) |
| mimalloc allocator switch | Measured and rejected: Windows gains were offset by sustained-RSS and serialization regressions (`bench/PERFORMANCE-INVESTIGATION.md`) |

## Priority & sequencing

| Priority | Item | Impact | Complexity | Status |
| --- | --- | --- | --- | --- |
| P0 | Baseline + compatibility gates | Critical | Medium | **done**, kept live |
| P0 | Load pipeline (fast tokenizer, vendored scraper) | Critical | High | **done** (2026-11-12) |
| P0 | Per-node materialization cost | High | High | **open** — dominant modern-API gap |
| P1 | Platform-specific packages | Medium | Low | todo |
| P1 | Binary size (opt-level experiment) | Medium | Low | todo (strip done) |
| P1 | JS loading / bundler fixtures | Medium | Medium | todo |
| P1 | Selector cache eviction | Medium | Low | **done** |
| P2 | Typed NAPI for remaining hot ops | Medium | Medium | partial (`setAttrs`/attr done; `setNode`/`traverse` open) |
| P2 | Query planning beyond the tag index | Medium | High | open |
| P2 | Reduced view materialization | High | High | open (merged with P0 materialization) |
| P3 | Memory / first-write costs | High | High | todo |
| P3 | Batch extraction scaling | High (batch) | High | todo |
| P3 | Real-page corpus beyond the 10-page sample | Medium | Low | todo |
| P4 | WASM experiment | Medium | Very high | deferred |

**Release sequence.** Shipped: packaging strip + selector eviction + batched
attributes (0.1.1 baseline work), load pipeline + attribute storage
(0.1.2). Next: per-node materialization cost, then platform-specific
packages + binary sizing, then query planning and memory.

Track the three workload profiles separately — small single-page scrapes,
large mutable documents, high-concurrency extraction — the fastest
implementation for one is not the fastest for all three.
