# Comparing two builds

Run `node bench/compare-builds.mjs --baseline /path/to/baseline/dist/modern.mjs --candidate /path/to/candidate/dist/modern.mjs --rounds 20 --json results.json`.

Each path must point to a complete, independently built package with its native binary. Build both packages using the same Node and Rust versions. `--only 'walk children,walk fields'` selects cases. Keep the machine idle and repeat the entire run when results are close.

Use `--cards 200` or `--cards 2000` for small and large generated inputs, and `--mode html`, `--mode xml`, or `--mode htmlparser2` to select parser behavior. The `data values` case includes an unpaired UTF-16 surrogate; attribute reads and writes provide controls without that value. Record JSON separately for each configuration. Compare complete time and operation-only time separately; neither comparison proves the absence of small regressions when its interval includes parity.

To use a real HTML page instead, pass `--file /path/to/page.html`. The JSON report records its SHA-256. Use `--only 'serialize document'` to verify the complete serialized output of the two builds as well as measuring load plus serialization. The repository's `bench/corpus/fetch.mjs` can fetch a small public Common Crawl sample; see its usage comment.

Each round starts a fresh process for each build, alternates their order, warms up five times, and records the median of ten actual load-plus-operation measurements. Every pair must return the same result. The report shows the median paired speedup and a percentile bootstrap interval over pairs; the JSON includes every pair and the median operation-only times. The interval describes sampling uncertainty in this run, not differences across machines, operating systems, or workloads. The two operations within a pair are sequential, so CPU frequency, thermal effects, and background work can still bias results.

Results are compared with V8 serialization so missing properties and `undefined` remain distinct. The JSON report includes hashes of the entry point, sibling JavaScript bundles, native binaries and input. It does not hash transitive dependencies outside the entry point's directory; preserve the package lockfile and toolchain alongside results.

The worker also records the process peak RSS after its timed samples; this includes runtime startup, the input, warmup, native allocations, and garbage collection. It is a coarse process-level peak rather than per-operation retained memory, and should be interpreted separately from timing.

The generated page is synthetic. This compares two Cheerox builds, not Cheerox against Cheerio, and does not establish that the 1.5x target has been met. Use representative input and separate Cheerio comparisons before making broader claims.

For a separate diagnostic run, execute `node bench/json-diagnostics.mjs 2000`. It counts JavaScript `JSON.parse` and `JSON.stringify` calls and their UTF-8 byte lengths during each operation after loading. The counters include codec processing as well as native transport and exclude JSON handled inside Rust. Instrumentation adds overhead and must not be used to compare timings.
