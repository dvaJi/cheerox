# cheerox — Performance & Optimization Roadmap

**Goal:** make cheerox the fastest and most memory-efficient implementation
of the Cheerio 0.22.0 API, without requiring any change to existing user
code.

This roadmap is grounded in the current measured profile
([docs/BENCHMARK.md](docs/BENCHMARK.md)) and in the actual implementation.
Every milestone is gated by the compatibility suites — an optimization that
moves a benchmark but breaks a gate is rejected.

## Guardrails (apply to every milestone)

- **The API is frozen.** `cheerio.load()`, callable module, selector
  signatures, node shapes, chaining — no redesign, no async `load()`.
- **Compatibility gates run on every change:**
  `npm run test:legacy` (576/577, oracle parity with `npm:cheerio@0.22.0`),
  `npm run test:differential` (55/55), `npm test`, `npm run test:upstream`
  (777), `cargo test` (57), `npm run test:types`, `npm run test:package`.
- **Benchmarks verify outputs before timing** (`bench/legacy.mjs`); a run
  with divergent output fails instead of reporting a speedup.
- Optimize the implementation, not the public API. Per-method tree shaking
  of a native addon is not a realistic goal for a fully compatible drop-in
  replacement.

## Current measured baseline (2026-10-30)

| Workload (vs cheerio@0.22.0) | Ratio | State |
| --- | ---: | --- |
| Parse only (small / large) | 1.94x / 2.16x | ahead |
| Parse + queries (large) | 1.28x | ahead |
| Attribute extraction (real-world) | 1.33x | ahead |
| Text extraction (large) | 1.56x | ahead |
| Serialization (large) | 2.71x | ahead |
| DOM mutations (small / large) | 0.24x / 0.28x | **behind** |
| Cold start + parse + query | 0.79x | behind |

Known structural cost: the legacy facade drives the engine through the
generic JSON `op()` interface, and every operation crosses the JS↔Rust
boundary once per selection/element. Callback-heavy mutation loops (several
tiny ops per element) cannot amortize that boundary; whole-tree workloads
(parsing, queries, serialization) can and do.

## M0 — Compatibility & profiling (mostly done, keep live)

**Status: exists.** `bench/legacy.mjs` (verified-output timings),
`test/differential/` (55 oracle-compared operations), the legacy suite at
oracle parity, and the full battery are wired into CI.

Remaining additions:

- Record **P95 latency**, **peak RSS**, and **V8 heap** alongside medians in
  `bench/legacy.mjs`.
- Add an **installation-size + cold-import** case: packed tarball size,
  `.node` size, `require()` time, ESM import time.
- Add a **memory scaling** case (load 10,000 documents in a loop; track RSS
  growth and GC behavior).
- Keep `docs/BENCHMARK.md` as the checked-in record per optimization round.

**Exit criteria:** complete 0.22.0 suite at oracle parity + reproducible
benchmark record on controlled hardware. *(Met; re-verified per PR.)*

## M1 — Lean packaging (P1, low risk)

**Rust build profile.** Current `[profile.release]`: `lto = "thin"`,
`codegen-units = 1`, no `strip`, default `opt-level = 3`.

- Measure `strip = "symbols"` first (largest size win, zero runtime risk).
- Experiment with an `opt-level = "s"` + `lto = "fat"` release-size profile;
  benchmark `.node` size AND runtime before adopting (size-optimized code
  can regress hot loops).
- Avoid `panic = "abort"`: an unexpected Rust panic must not kill the Node
  process.

**JavaScript loading.**

- Audit ESM exports for `sideEffects` accuracy; verify with esbuild/Rollup
  fixtures that bundlers can drop unused internal modules while
  `require('cheerox')` behaves identically.
- Keep I/O, streaming, and worker modules out of the synchronous startup
  path where lazily loading them preserves behavior.

**Platform packaging.**

- Move to NAPI-RS's platform-specific optional packages
  (`@cheerox/<platform>-<arch>`) so consumers download one binary instead of
  the universal tarball; keep the current single-tarball flow as fallback.
- Track: tarball size, install-time download, cold-import time.

**Targets (provisional, measure before/after):** −20% native binary size,
no runtime regression beyond noise on `bench/legacy.mjs`.

## M2 — Selector engine (P1–P2)

Facts today: parsed selectors are cached in a **thread-local
`HashMap<String, Rc<Vec<Complex>>>` capped at 512 entries that is cleared
entirely when full**; matching is right-to-left with a memo table and
document-order results.

- **A. Bounded eviction.** Replace clear-on-full with cheap bounded eviction
  (generational LRU or two-generation FIFO) so a scraper cycling >512
  selectors does not throw away its hot set. Low complexity.
- **B. Query planning.** Profile before extending: id/class/tag candidate
  indexes only pay off above document-size thresholds. Priority order:
  `#id` direct lookup, tag scan for the last compound, attribute filtering
  over tag candidates.
- **C. Compiled-program reuse across documents.** The parse cache is
  thread-local; batch workloads (`extractAll` on rayon threads) rebuild
  programs per thread. Consider a shared concurrent cache or seeded caches.
- **Constraints:** DOM mutations, XML case sensitivity, custom pseudos,
  `:scope`/leading combinators, and result ordering must stay byte-identical
  (the legacy pseudo-allowlist and 0.22.0 scoped semantics are enforced in
  the facade and must keep applying).

## M3 — JS↔Rust bridge overhead (P2, targets the mutations gap)

The generic path is `document.op(command, JSON.stringify(args))` →
`serde_json` parse → `primitive()` dispatch → JSON result. Typed direct
methods already exist for `select`, `text`, `attr`, `innerHtml`,
`outerHtml`, `render`, `parseAsync`; the legacy facade's hot paths
(`setAttrs`, `traverse`, `create`, `setNode`) still go through JSON.

- **Typed NAPI bindings** for the highest-frequency generic ops, starting
  with `setAttrs` (it is the mutations-bottleneck write path).
- **Return primitives/native arrays directly** instead of JSON strings for
  id lists and attribute reads.
- **Fuse operations** whose intermediates are not observable from JS (e.g.
  parse→query inside one call for `load`+`$()` patterns) — only where no
  callback can interleave.
- **Do not batch across observable side effects:** callbacks in
  `.each()`/`.map()` may mutate the DOM; execution order is part of the
  0.22.0 contract. This is why per-element mutation loops on tiny trees stay
  behind 0.22.0 today — the fix is cheaper ops, not reordering.
- **Reduce lazy-view materialization:** `toArray()`/`find` results already
  avoid full materialization above thresholds; extend the pattern to
  `map()`/`each()` iteration.

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
| Parser rewrite | High risk, zero user-visible gain |

## Priority & sequencing

| Priority | Item | Impact | Complexity | Status |
| --- | --- | --- | --- | --- |
| P0 | Baseline + compatibility gates | Critical | Medium | **done**, kept live |
| P1 | Binary size (strip/profiles) | Medium | Low | todo |
| P1 | Platform-specific packages | Medium | Low | todo |
| P1 | JS loading / bundler fixtures | Medium | Medium | todo |
| P1 | Selector cache eviction | Medium–High | Low | todo |
| P2 | Typed NAPI for hot ops | High | Medium | todo (`setAttrs` first) |
| P2 | Query planning | High | High | todo |
| P2 | Reduced view materialization | High | High | todo |
| P3 | Memory / first-write costs | High | High | todo |
| P3 | Batch extraction scaling | High (batch) | High | todo |
| P4 | WASM experiment | Medium | Very high | deferred |

**Release sequence.** First optimization release: packaging + hot paths
(M1 + selector eviction + typed `setAttrs`). Second: query planning,
allocations, memory. Third: deployment portability + extraction scaling.

**Provisional targets for the first cycle** (measure on controlled hardware;
targets are planning inputs, not achievements): native binary −20%, repeated
hot-selector latency −15%, peak RSS −15% on large-document and batch
workloads, compatibility stays 100% with no unexplained skips.

Track the three workload profiles separately — small single-page scrapes,
large mutable documents, high-concurrency extraction — the fastest
implementation for one is not the fastest for all three. That is exactly
what today's numbers show: whole-tree workloads lead, tiny-tree mutation
loops trail.
