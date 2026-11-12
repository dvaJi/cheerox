# Legacy benchmark report

`npm run bench:legacy` — cheerox's 0.22.0-compatible facade against the real
`cheerio@0.22.0` (installed as `cheerio-legacy-reference`). Windows x64,
Node v24.18.0, 2026-11-08. Median of 5 measured runs after 3 warmups; every
case verifies that both engines produce equivalent output before the times
are reported (the runner fails if any output diverges, and mutation cases
compare full serialized HTML). Results are from this machine and revision;
treat ratios, not absolute numbers, as the signal.

| Workload | cheerox | cheerio 0.22.0 | cheerox/oracle |
| --- | ---: | ---: | ---: |
| Parse only (small, 20 articles) | 0.214 ms | 0.604 ms | **2.83x faster** |
| Parse only (large, 2,000 articles) | 6.84 ms | 13.81 ms | **2.02x faster** |
| Parse + queries (large) | 17.99 ms | 24.41 ms | **1.36x faster** |
| Attribute extraction (real-world page) | 0.97 ms | 1.38 ms | **1.42x faster** |
| Text extraction (large) | 12.24 ms | 15.80 ms | **1.29x faster** |
| DOM mutations (small, 20 articles) | 0.72 ms | 0.91 ms | **1.26x faster** |
| DOM mutations (large, 2,000 articles) | 52.43 ms | 61.99 ms | **1.18x faster** |
| Serialization (large, html+xml+element) | 14.34 ms | 34.18 ms | **2.38x faster** |
| Warm root re-require + parse + query | 0.30 ms | 0.32 ms | **1.06x faster** (parity/noise) |

## Honest reading

All nine legacy benchmark workloads match or beat `cheerio@0.22.0` on this
run. The largest wins are serialization (2.38x) and parsing (2–2.8x), where
native parsing/selection/rendering replace whole-tree JavaScript walks.

The two mutation workloads were previously slower because the callback-heavy
case crossed the JavaScript↔Rust boundary once per node operation. The
legacy facade now batches static `before`/`after` parsing/insertion, groups
removal, uses typed native attribute/class paths, avoids per-parse root-child
materialization, and reduces node-view/root-loading overhead. The mutation
case still verifies full serialized HTML, so the measured gain preserves the
0.22.0 DOM/result shape.

The warm root re-require case is effectively parity and can move slightly
with module-cache/measurement noise; the root entrypoint now defers modern
async extensions until first use so the legacy compatibility path does not
pay to load them.

## When to prefer which

- Loading, querying, extracting, mutating, or serializing documents of
  real size: cheerox's legacy facade is faster on this benchmark set.
- If you need exact Cheerio 0.22.0 behavior beyond the covered API surface,
  verify with the differential/legacy suites for the specific feature.

## Reproducing

```sh
npm run bench:legacy
```

Requires only the dev dependencies; the oracle is
`cheerio-legacy-reference` (`npm:cheerio@0.22.0`) and is never imported by
the library itself.
