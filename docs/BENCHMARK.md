# Legacy benchmark report

`npm run bench:legacy` — cheerox's 0.22.0-compatible facade against the real
`cheerio@0.22.0` (installed as `cheerio-legacy-reference`). Windows x64,
Node v24.18.0, 2026-10-30. Median of 5 measured runs after 3 warmups; every
case verifies that both engines produce equivalent output before the times
are reported (the runner fails if any output diverges). Results are from
this machine and revision; treat ratios, not absolute numbers, as the signal.

| Workload | cheerox | cheerio 0.22.0 | cheerox/oracle |
| --- | ---: | ---: | ---: |
| Parse only (small, 20 articles) | 0.114 ms | 0.221 ms | **1.94x faster** |
| Parse only (large, 2,000 articles) | 5.1 ms | 11.0 ms | **2.16x faster** |
| Parse + queries (large) | 15.4 ms | 19.7 ms | **1.28x faster** |
| Attribute extraction (real-world page) | 0.96 ms | 1.27 ms | **1.33x faster** |
| Text extraction (large) | 8.9 ms | 13.9 ms | **1.56x faster** |
| DOM mutations (small, 20 articles) | 2.1 ms | 0.51 ms | 0.24x |
| DOM mutations (large, 2,000 articles) | 165.8 ms | 46.3 ms | 0.28x |
| Serialization (large, html+xml+element) | 11.9 ms | 32.4 ms | **2.71x faster** |
| Cold start + parse + query | 0.31 ms | 0.24 ms | 0.79x |

## Honest reading

**Seven of nine workloads are faster**, including parsing (2x), queries,
text/attribute extraction, and serialization (2.7x — the 0.1.x serializer
rules run natively). Two remain slower, for a structural reason:

- **DOM mutations** — the case is callback-heavy: one `each` iteration per
  article, each doing an `attr` write, a `find`, an `addClass`, and an
  `after` that re-renders the sibling HTML. That is several thousand tiny
  JavaScript↔Rust boundary crossings on cheerox versus plain property
  assignments on plain objects for 0.22.0, whose entire engine lives in
  JavaScript. The per-operation cost (~15µs) does not amortize when each
  operation touches one node on a small tree.
- **Cold start** — the cheerox bundle initializes a larger native module.

Everything else pays off because one native call replaces whole-tree
JavaScript walks: parsing (Rust tokenizer + arena), `find` (native scoped
select), `.text()` (native extraction), and rendering (native 0.1.x-rules
serializer, byte-verified against the port).

## When to prefer which

- Loading or extracting from a document of any real size: cheerox wins.
- Heavy per-element mutation loops on small trees: 0.22.0's engine wins;
  batch writes through cheerox's selection APIs (`attr(map)`,
  `addClass` on a selection) where possible — the facade coalesces those
  into single native calls (a `setAttrs` batch operation).

## Reproducing

```sh
npm run bench:legacy
```

Requires only the dev dependencies; the oracle is
`cheerio-legacy-reference` (`npm:cheerio@0.22.0`) and is never imported by
the library itself.
