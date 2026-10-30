# Legacy benchmark report

`npm run bench:legacy` — cheerox's 0.22.0-compatible facade against the real
`cheerio@0.22.0` (installed as `cheerio-legacy-reference`). Windows x64,
Node v24.18.0, 2026-10-30. Median of 5 measured runs after 3 warmups; every
case verifies that both engines produce equivalent output before the times
are reported. Results are from this machine and revision; treat ratios, not
absolute numbers, as the signal.

| Workload | cheerox | cheerio 0.22.0 | cheerox/oracle |
| --- | ---: | ---: | ---: |
| Parse only (small, 20 articles) | 0.108 ms | 0.245 ms | **2.27x faster** |
| Parse only (large, 2,000 articles) | 6.1 ms | 11.1 ms | **1.8x faster** |
| Parse + queries (large) | 31.2 ms | 18.1 ms | 0.58x |
| Attribute extraction (real-world page) | 1.17 ms | 1.13 ms | 0.96x |
| Text extraction (large) | 15.0 ms | 13.4 ms | 0.89x |
| DOM mutations (small) | 3.2 ms | 0.54 ms | 0.17x |
| Serialization (large, html+xml+element) | 100 ms | 30.7 ms | 0.31x |
| Cold start + parse + query | 0.32 ms | 0.22 ms | 0.67x |

## Honest reading

- **Parsing is 1.8–2.3x faster** (Rust tokenizer/arena vs the JS
  htmlparser2). Loading is the dominant cost of most scraping workloads,
  which is why the real-world attribute-extraction case lands at parity
  despite slower downstream operations.
- **Per-operation work over already-loaded trees is slower.** 0.22.0's nodes
  are plain JS objects from parse time, so its traversal/mutation code pays
  no view-materialization or boundary costs; the cheerox facade keeps the
  DOM in the native arena and pays one view/record hop per node touched.
  Queries also run a candidate materialization step (context subtree +
  native `matches`) rather than css-select's compiled walkers.
- **Serialization** walks the tree through the same per-node views. The
  known next step (see PLAN.md) is a native port of the 0.1.x serializer,
  which would remove the per-node boundary hops entirely.

These are the measured trade-offs of keeping a live native DOM behind the
0.22.0 object model. Correctness gates (legacy suite at oracle parity,
55/55 differential cases) run before every timing, and the benchmark fails
if any output diverges.
