# Benchmarks in VMs

Use a Linux VM with at least eight available CPUs, 16 GB of RAM, Node.js 20.19 or newer, npm, Rust, and `taskset`. Build and validate the package before measuring it. Run benchmarks and builds sequentially so they do not compete for CPU or memory.

```sh
ssh user@vm
git clone https://github.com/dvaJi/cheerox.git
cd cheerox
npm ci
npm run build
npm test
npm run test:upstream
npm run test:types
npm run test:package
node --test bench/suite/worker-pool.test.mjs bench/compare.test.mjs
node --expose-gc bench/fair.mjs --require-cap --output bench/results/fair/current.json
exit
scp 'user@vm:~/cheerox/bench/results/fair/current.json' bench/results/fair/
```

Shut down the VM after copying the reports. `--quick` uses smaller fixtures and three samples for a smoke run; it does not produce the nine-sample recorded comparison. The recorded full suite used two sequential invocations: `--only sync,pools`, then `--append --only cold,stream,retention,concurrent`. Appending requires identical source and native binary hashes, plus identical native build metadata.

## Real pages

`bench/corpus/fetch.mjs` downloads pages from one public Common Crawl WARC file (HTTP 200 responses with an HTML content type and a UTF-8 body) and writes them with a manifest; `bench/corpus.mjs` runs a typical scraping job on each page with both engines: load, title and metadata, headings, links, images with their link ancestry and depth, structured data, a paragraph filter, an element count, removal of scripts and styles, body text and serialization. Outputs must match exactly, and a page whose outputs differ is reported instead of timed. Times include loading. After a warm-up, each page reports the median of five samples per engine, alternating which engine runs first; a sample repeats the job until it lasts about a millisecond, so timer resolution and single collection pauses do not decide small pages.

```sh
node bench/corpus/fetch.mjs bench/corpus/pages 5000
node bench/corpus.mjs bench/corpus/pages --json bench/results/corpus.json
```

## Single operations

`bench/operations.mjs` times one operation at a time on freshly loaded generated documents, in HTML, XML or htmlparser2 mode (`--mode`), and checks that both engines return the same value. Each sample loads a new document outside the timed section, so work an engine defers to first use is charged to the operation; the reported "with load" ratio adds each engine's median load time. `bench/gate.mjs` runs a quick pass in HTML and XML mode and fails when an operation falls below its floor; CI runs it on Linux.

## Matched CPU comparison

`bench/fair.mjs` compares Cheerio 1.2.0 against Rust with the same process-wide CPU budgets of one, two, four, and eight CPUs. On Linux each child process and all its threads share an enforced `taskset` affinity mask. Cheerio uses a real, bounded `worker_threads` pool with reused workers; Rust uses its process-wide native worker limit. Concurrent batches share each engine's pool. This comparison includes input/result structured cloning for Cheerio and input/result conversion across the native bridge for Rust.

Warm results exclude imports, worker initialization, and warm-up. Cold results include engine import, pool initialization, and the first batch; they exclude child Node startup and common fixture generation. Cold comparison tables use `coldInitializationAndWorkMs`, rather than operation-only `elapsedMs`. Both engines use the same Node version and garbage-collection policy. Pre-sample collection and complete output equality checks run outside timed sections. The retention workload includes its periodic collection and checkpoint bookkeeping in both engines' elapsed time. Every measured sample must match the reference's canonical SHA-256 output.

For cold rows, the raw report's generic `medianMs` and `speedupVsCheerio` fields describe operation time alone. Use `initializationAndWork`, or the comparison report's `coldInitializationAndWorkMs` metric, for startup-inclusive results.

The full suite contains 45 cases, each with nine samples per engine:

| Cases | Work |
| --- | --- |
| 12 synchronous cases | Parse/query, HTML mutation, XML mutation, and cross-document moves on 20, 500, and 5,000 article or item elements, one CPU each. |
| 16 warm pool cases | Simple extraction from 16 documents at each size and nested extraction with JavaScript callbacks from eight medium documents, each at 1/2/4/8 CPUs. |
| 8 cold cases | First extraction batch of 16 tiny or large documents, including engine and pool initialization at each CPU budget. |
| 4 streaming cases | Actual `decodeStream` parsing of HTML and XML with 50,000 elements, 32 KiB input chunks, at one and eight CPUs. |
| 1 retention case | Append, update, and remove nodes for 4,000 cycles while retaining only 32 live article elements; RSS and heap checkpoints every 200 cycles. |
| 4 concurrent cases | Eight simultaneous batches, each containing eight medium documents, checking one global worker limit at each CPU budget. |

Fixtures are deterministic generated news/catalog documents, including nested text, lists, tables, UTF-8 text, entities, and XML CDATA. They are not a downloaded web corpus. Callback extraction remains JavaScript work: Cheerio workers can run callbacks on their worker threads, while native extraction callbacks execute through the JavaScript API. The callback case deliberately measures that difference.

Each engine/workload runs in an isolated process. Cold, streaming, and retention samples each receive a fresh process. Streaming inputs are resident in memory for both engines, and the measurements include that matched input. RSS includes native allocation, JavaScript heaps, and worker overhead. A five-millisecond timer samples RSS and event-loop delay; it can miss memory spikes. Timer lag covers the operation, excluding engine/pool initialization even in cold cases. `processLifetimePeakRssBytes` also includes engine initialization and earlier work in the same process. End-of-operation memory is sampled before output validation. A fixed live DOM size and a flat RSS curve support a retention comparison for this workload; they do not prove a universal memory bound.

The [baseline report](results/fair/baseline.json) records the implementation before the worker-budget, incremental-streaming, and removed-node collection changes. Both that baseline and the final native addon were built with Rust 1.99.0 and Cargo 1.99.0 in the same pinned manylinux image with glibc 2.28. The [baseline build record](results/fair/baseline-build.json) identifies its binary and toolchain. The original Rust 1.97 measurement is preserved separately in [the historical baseline](results/fair/baseline-rust1.97.json); it is not used for the matched comparison.

`bench/compare.mjs` rejects differing CPU masks, Node versions, native compilers, build images, libc build baselines, workloads, input hashes, sample counts, or output hashes. It reports every case, including losses, and requires final native concurrency telemetry to stay within the configured worker limit. JavaScript dependency and bundler changes are identified by each report's package and lockfile hashes; the comparison is an implementation revision comparison rather than a controlled attribution to any single optimization.

```sh
node bench/compare.mjs bench/results/fair/baseline.json bench/results/fair/current.json bench/results/fair/comparison.json
```

Raw reports contain the source hashes of the measured revision. Current reports recursively include Rust parser patches under `native/vendor`, compiler versions, and native binary hashes. Historical baseline reports preserve their original provenance fields.

The development history was squashed into one initial commit in preparation for publication. Revision identifiers in historical reports refer to those earlier development snapshots and are not checkout targets in the public history. Recorded measurements and source/binary checksums are preserved unchanged.

When benchmarking an addon built in a separate release container, pass `--native-build path/to/build.json`. The file must provide `toolchain.rustc`, `toolchain.cargo`, and a `nativeBinarySha256` filename-to-hash map matching the measured binaries. The report then distinguishes the binary's build toolchain from the benchmark host's installed toolchain.

## October 14, 2026 results

[`results/2026-10-14/`](results/2026-10-14/) holds the measurements the main README reports: [real pages](results/2026-10-14/corpus.json) (5,000 Common Crawl pages; page URLs omitted), [single operations](results/2026-10-14/operations-html.json) in HTML and [XML](results/2026-10-14/operations-xml.json) mode, and [the matched CPU suite](results/2026-10-14/fair.json). They measured release 1.1.6 (revision 0ee5db7) with Node 24.18.1 on an eight-CPU Linux x64 VM of the same type as the earlier record, with the addon built on the VM by Rust 1.99.0 rather than in the pinned release image, so `bench/compare.mjs` does not pair this report with the earlier baseline.

Outputs matched on all 5,000 pages and in every operation and matched CPU sample. Cheerox was 2.22× faster in total and faster on 4,963 pages in the full pass; the other 37 measured 1.20× to 2.04× faster when rerun with 25 samples each on the same machine. It was faster including load in 50 of 50 HTML and 48 of 50 XML operation measurements in each of two runs, and in all 45 matched CPU cases. The XML measurements it lost both walk every node and enumerate each element's attributes.

## Recorded matched results, October 13, 2026

These October 13, 2026 UTC measurements used Node 24.18.1 on a Linux x64 VM with eight available CPUs, an AMD Ryzen 9 9950X host, and 16.77 GB of reported memory. The measured development snapshot is `2bb7cb960d88c998315256725fef759eee246fb8`. The portable native binary was built from the identical Rust sources at 7b1efeb; [its build record](results/fair/current-build.json) records Rust 1.99.0, the pinned glibc 2.28 image, ELF requirements, and the binary checksum. Later Node 20 HTTP multipart and deployment-test fixes are outside these workloads; the benchmark source hashes remain those actually measured.

Both the baseline and final run passed all 810 sample output checks: 45 cases × nine samples × two engines. Rust had the lower median elapsed time in 39 cases. Its six losses were all four callback extraction cases, eight-CPU XML streaming, and the retention workload. `C/R` below is Cheerio time divided by Rust time; a value below 1 means Rust was slower. All times are milliseconds.

Compared with the earlier Rust implementation, the final implementation had lower medians in nine cases and higher medians in 36. Callback extraction improved by 1.74–2.59× and retention memory use improved, while tiny cold-start totals rose from roughly 5–6 ms to 27–34 ms. The additional compatibility work has costs. The [complete comparison](results/fair/comparison.json) preserves every before/after ratio, including regressions.

### Synchronous parsing and mutations

| Workload | Elements | Cheerio ms | Rust ms | C/R |
| --- | --- | --- | --- | --- |
| Parse/query | 20 | 4.38 | 0.55 | 7.93× |
| HTML mutation | 20 | 4.71 | 1.00 | 4.73× |
| XML mutation | 20 | 1.07 | 0.60 | 1.78× |
| Cross-document move | 20 | 4.51 | 0.95 | 4.74× |
| Parse/query | 500 | 35.25 | 4.08 | 8.64× |
| HTML mutation | 500 | 39.10 | 11.60 | 3.37× |
| XML mutation | 500 | 13.03 | 2.71 | 4.81× |
| Cross-document move | 500 | 35.93 | 11.94 | 3.01× |
| Parse/query | 5,000 | 150.57 | 41.64 | 3.62× |
| HTML mutation | 5,000 | 239.65 | 189.49 | 1.26× |
| XML mutation | 5,000 | 65.02 | 28.00 | 2.32× |
| Cross-document move | 5,000 | 204.28 | 163.81 | 1.25× |

### Reused worker pools

| CPUs | Extraction | Articles/document | Documents | Cheerio ms | Rust ms | C/R |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Simple | 20 | 16 | 27.32 | 2.17 | 12.62× |
| 1 | Simple | 500 | 16 | 249.12 | 43.70 | 5.70× |
| 1 | Simple | 5,000 | 16 | 2887.61 | 511.48 | 5.65× |
| 1 | Nested + callback | 500 | 8 | 243.68 | 272.27 | 0.89× |
| 2 | Simple | 20 | 16 | 23.63 | 1.49 | 15.83× |
| 2 | Simple | 500 | 16 | 198.03 | 25.47 | 7.77× |
| 2 | Simple | 5,000 | 16 | 1780.13 | 306.37 | 5.81× |
| 2 | Nested + callback | 500 | 8 | 190.15 | 255.00 | 0.75× |
| 4 | Simple | 20 | 16 | 14.32 | 1.68 | 8.52× |
| 4 | Simple | 500 | 16 | 133.72 | 21.39 | 6.25× |
| 4 | Simple | 5,000 | 16 | 1464.46 | 183.68 | 7.97× |
| 4 | Nested + callback | 500 | 8 | 106.15 | 219.35 | 0.48× |
| 8 | Simple | 20 | 16 | 7.34 | 0.89 | 8.21× |
| 8 | Simple | 500 | 16 | 87.39 | 12.66 | 6.90× |
| 8 | Simple | 5,000 | 16 | 797.55 | 114.70 | 6.95× |
| 8 | Nested + callback | 500 | 8 | 54.30 | 174.06 | 0.31× |

### Cold engine and pool initialization plus first batch

| CPUs | Articles/document | Cheerio ms | Rust ms | C/R |
| --- | --- | --- | --- | --- |
| 1 | 20 | 163.26 | 33.54 | 4.87× |
| 1 | 5,000 | 3252.92 | 527.08 | 6.17× |
| 2 | 20 | 152.16 | 28.96 | 5.25× |
| 2 | 5,000 | 1915.19 | 319.33 | 6.00× |
| 4 | 20 | 154.03 | 27.83 | 5.54× |
| 4 | 5,000 | 1340.62 | 214.47 | 6.25× |
| 8 | 20 | 169.23 | 27.37 | 6.18× |
| 8 | 5,000 | 1159.36 | 168.10 | 6.90× |

Each cold batch contains 16 documents. These numbers include engine import and pool initialization; they are not the operation-only medians in the raw rows.

### Streaming time, memory, and responsiveness

Streams contain 50,000 article or item elements and use 32 KiB chunks. RSS is the median sampled peak, in decimal MB. Lag is the median of each sample’s maximum timer delay.

| Format | CPUs | Engine | Time ms | RSS MB | Lag ms | Timer ticks |
| --- | --- | --- | --- | --- | --- | --- |
| HTML | 1 | cheerio | 1107.78 | 698.5 | 1102.95 | 0 |
| HTML | 1 | cheerox | 346.21 | 372.6 | 0.90 | 68 |
| XML | 1 | cheerio | 190.80 | 230.8 | 189.73 | 0 |
| XML | 1 | cheerox | 162.00 | 276.0 | 0.72 | 32 |
| HTML | 8 | cheerio | 592.34 | 709.3 | 594.22 | 0 |
| HTML | 8 | cheerox | 341.09 | 372.1 | 0.80 | 67 |
| XML | 8 | cheerio | 119.85 | 228.7 | 115.23 | 0 |
| XML | 8 | cheerox | 162.28 | 275.4 | 0.63 | 32 |

Rust XML streaming at eight CPUs was slower and used more RSS than Cheerio. Its parsing ran off the JavaScript thread, allowing timers to run. In the warm large eight-CPU extraction batch, Rust used 405.5 MB sampled RSS versus Cheerio’s 2,656.3 MB, but had 24.06 ms median maximum timer lag versus 3.49 ms. Native input/result conversion still executes on the JavaScript thread.

### Sustained mutation and retention

The DOM stays at 32 live article elements over 4,000 append/update/remove cycles. Each checkpoint performs collection. RSS rises during warm-up; the later checkpoints matter when assessing continued retention. Growth below is the median of paired per-sample differences, so it need not equal the difference of independently reported checkpoint medians.

| Engine | Time ms | RSS at 200 cycles MB | RSS at 4,000 cycles MB | Growth 200→4,000 MB | Growth 2,000→4,000 MB |
| --- | --- | --- | --- | --- | --- |
| cheerio | 593.28 | 93.0 | 93.0 | 0.8 | 0.1 |
| cheerox | 614.76 | 82.1 | 97.6 | 15.2 | 0.4 |

Rust’s median within-sample RSS growth from cycle 200 to 4,000 fell from 46.50 MB in the baseline to 15.21 MB. Its curve plateaued near 97 MB after warm-up: growth from cycle 2,000 to 4,000 fell from 20.95 MB to 0.40 MB. Cheerio’s growth over that later interval was 0.13 MB. The final Rust retention time was slightly higher than Cheerio’s; this workload supports improved retention rather than a universal memory bound.

### Concurrent batches and one shared worker limit

Each case starts eight simultaneous batches of eight 300-article documents. Both pools stayed within the budget; native telemetry recorded zero active batches/workers after every sample.

| CPUs | Cheerio ms | Rust ms | C/R | Cheerio RSS MB | Rust RSS MB | Native peak workers |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 485.07 | 106.58 | 4.55× | 423.5 | 93.3 | 1 |
| 2 | 316.94 | 59.95 | 5.29× | 550.7 | 97.2 | 2 |
| 4 | 202.22 | 34.28 | 5.90× | 914.8 | 100.4 | 4 |
| 8 | 112.55 | 19.07 | 5.90× | 1327.2 | 107.1 | 8 |

Raw data: [final run](results/fair/current.json), [matched baseline](results/fair/baseline.json), [all-case comparison](results/fair/comparison.json), and [validation and VM cleanup](results/fair/validation.json). The raw reports retain timing distributions, checkpoint timelines, input/output hashes, source hashes, and binary provenance.

## Historical measurements

The following earlier October 13, 2026 UTC runs used a Linux x64 VM with eight available CPUs, an AMD Ryzen 9 9950X host, 16.8 GB of reported memory, and Node 24.18.1. Cheerio 1.2.0 is the reference. These are medians of nine samples after a correctness warm-up, with explicit garbage collection outside the timed sections. Every sample passed equal-output assertions.

| Workload | Cheerio | Rust | Speedup |
| --- | ---: | ---: | ---: |
| Load/query, 20 articles | 1.77 ms | 0.36 ms | 4.91× |
| Load/query, 500 articles | 12.67 ms | 2.59 ms | 4.90× |
| Load/query, 5,000 articles | 85.98 ms | 28.82 ms | 2.98× |
| Extract 32 documents × 20 articles, eight threads | 16.43 ms | 1.20 ms | 13.72× |
| Extract 32 documents × 500 articles, eight threads | 245.69 ms | 13.28 ms | 18.50× |
| Extract 32 documents × 5,000 articles, eight threads | 4,048.06 ms | 143.97 ms | 28.12× |
| HTML mutations, 2,000 articles | 26.83 ms | 18.57 ms | 1.45× |
| XML mutations, 4,000 items | 13.58 ms | 12.13 ms | 1.12× |
| Move 2,000 articles between documents | 23.72 ms | 20.06 ms | 1.18× |

These historical batch comparisons gave Rust eight workers while Cheerio ran serially, so their speedups are not matched-CPU results. The eight-thread extraction times include input conversion, native parsing and extraction, and JavaScript result conversion. The Cheerio batch runs serially. Rust with one worker took 3.23, 59.59, and 702.97 ms for the same small, medium, and large batches; eight workers improved those times by 2.70×, 4.49×, and 4.88×. These generated documents do not establish a universal speedup. Local macOS three-sample smoke runs without explicit garbage collection showed slower Rust mutation, XML, and move workloads. The hardware, runtime, sample count, and collection policy differ from this Linux run.

In a separate large-batch responsiveness sample, serial Cheerio took 4,018.83 ms, allowed zero timer ticks during work, and delayed the timer by 4,013.89 ms. Rust with eight workers took 124.54 ms, allowed 21 timer ticks, and had 5.94 ms maximum timer lag. With one worker it took 657.70 ms, allowed 125 ticks, and had 7.48 ms maximum lag. Tick counts reflect different workload durations; the timer runs every five milliseconds. Native async parsing/extraction runs off the JavaScript thread, while input and result conversion still execute on it.

The sustained stress run checked 1,280 documents containing 2,000 articles each across 20 batches, processing 610.2 MB of HTML in 1.779 seconds including assertions: 719.6 documents/second and 343.0 MB/second. Timers fired 245 times with 48.99 ms maximum lag. Sampled RSS reached 431.3 MB and final RSS was 432.5 MB; sampling does not determine the absolute peak or prove a memory bound.

Raw reports: [extraction and responsiveness](results/vm-full.json), [mutable engine](results/vm-engine.json), and [stress](results/vm-stress.json). Reports include environment details and timing distributions where applicable. Infrastructure labels and report filenames are generic; recorded measurements and source hashes are preserved.

The [validation record](results/validation.json) describes the revision used for these measurements: source and binary checksums, native checks, all 739 upstream and 118 additional runtime tests on Node 20.19, 22 and 24, TypeScript compatibility, clean npm installation checks and VM cleanup. The local npm tarball checked in that run included macOS arm64 and Linux x64 glibc binaries. Five other platform targets were configured in CI and were not executed in that run.

That earlier validation covered the 739-test subset. The subsequent [complete Cheerio suite run](../test/upstream/full-suite-validation.json) includes all 14 upstream files and 777 tests, including parser and utility tests, plus 121 additional runtime tests.

Earlier hybrid-engine measurements are archived under `results/hybrid-baseline/`. Validation records retain the source hashes of the measured revisions.
