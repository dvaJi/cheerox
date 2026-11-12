# Performance investigation: local checkpoint

For the goal, current scorecard and remaining work, see [PERFORMANCE-PLAN.md](./PERFORMANCE-PLAN.md).

## Load-phase diagnosis and fast whole-tag tokenization

A phase diagnostic on the exact 494 KB `operations.mjs` generated-2000 fixture (release build, 35 samples after five warmups, `cargo test --release profile_load_fixture_phases -- --ignored --nocapture`) showed the load is almost entirely the html5ever parse: `sized_html` 12–14 µs, parse into the scraper ego-tree via `CompatibleSink` 23.8 ms, document preparation 0.71 ms, and the lazily deferred arena conversion 3.5 ms. A tokenizer-only probe (a `DropSink`, `profile_load_fixture_null_sink`) measured 14.5 ms for tokenization alone: the Data state already has an SSE2 fast path for text runs, but every tag's markup walked the per-character state machine, at roughly 30 ns per byte of markup.

The vendored html5ever tokenizer now scans a whole well-formed tag in one pass (`try_fast_tag`): it reads the front chunk as bytes, accepts a deliberately narrow grammar (`[A-Za-z0-9]` tag names, `[-_.:@A-Za-z0-9]` attribute names, quoted values without `&`, `\0`, CR or non-ASCII, unquoted printable values without quotes, `=`, `<`, backtick or `&`), collects attribute ranges without mutating anything, and only on a fully parsed tag fills the token state and emits through `emit_current_tag`. End tags are folded into the same scan from the TagOpen state, skipping the machine's EndTagOpen hop. Anything unusual bails without consuming input, and the state machine then handles those bytes exactly as before. On the 2,000-card fixture the scanner commits 38,019 tags and bails only on the doctype, the `<!` and the `< 2` inside the script.

Dropped tokenizer parse errors are unobservable: the main parse passes `CompatibleSink::new`, which has no error collector, and scraper's `parse_error` is a no-op without its `errors` feature. Parse errors, diagnostics and source locations flow through a separate html5gum-driven parse (`diagnostics::parse_with_sink`), so the fast path cannot change what users observe. Two correctness bugs found during development were caught by the existing Rust suites: the machine reaches `emit_current_tag` with the post-tag state set (`emit_tag Data`), which the sink result then overrides, and the first implementation's name range excluded the tag's first letter.

After the change the same diagnostics measure parse at 14.0 ms, preparation at 0.61 ms, tokenizer-only at 4.5 ms, and a null-sink parse at 6.9 ms. Paired against the build at the PR head (30 alternating rounds, the compare harness's 220 KB article fixture), HTML load-only went 13.01 → 7.00 ms, 1.857x (1.815–1.873). Raw paired data is in `%TEMP%\cheerox-fastpath-ab.json`, `%TEMP%\cheerox-fastpath-full-2000.json` and `%TEMP%\cheerox-fastpath-final2-2000.json`.

## Attribute objects without a proxy

Node `attribs` used to be a `Proxy` over a plain target with `set`, `deleteProperty` and `defineProperty` traps. The proxy tax dominated attribute-heavy JavaScript walks: a micro-benchmark measured `Object.keys(proxy)` at about 575 ns per call versus 58 ns for a plain object, and the warm 2,000-card `walk with fields` spent 6.1 of its 6.9 ms in `Object.keys(node.attribs)`.

`attribs` is now a real object whose enumerable keys are shared accessor pairs (one pair per attribute name, cached in a module map, reading `this`); values live in a per-object metadata record attached under a non-enumerable symbol, together with the view and the generation the values were copied in. The write hook is one shared function, not a per-object closure — the first implementation created a closure per attribute object and showed a repeatable XML `attributes` operation-only regression (0.704x, 0.685–0.738), which fell to parity once the closure and a second symbol define were removed (total 1.019x, 1.001–1.033, over 60 pairs). Reads that only mirror the record stay cheap: warm `attribs.href` reads cost about 10 ns per node on the 2,000-card XML fixture.

Compatibility kept: `node.attribs` identity is stable across native writes (existing test), held references reflect later `.attr()` writes, direct writes to existing keys still reach the record (`first.attribs.id = 'direct'` in the native-hooks suite), `__proto__` remains a plain data property because reflection expects a value descriptor and an accessor would shadow the prototype's setter, and the metadata symbols are non-enumerable so `assert.deepStrictEqual` and `JSON.stringify` see only attribute keys — the first draft attached them with plain assignment, which made them enumerable and failed the tokenizer fixture tests. Two direct-write behaviors of the proxy are gone: `delete attribs.key` and `Object.defineProperty(attribs, …)` no longer push through to the record; no test in the JS, legacy, upstream or differential suites exercised either.

Warm 2,000-card walk diagnostics after the redesign: `attribs keys` 2.25 ms (from 6.09), full-fields walk 3.54 ms (from 6.93). Paired totals against the PR-head build on the 220 KB HTML fixture (final run, 30 rounds): walk children 1.629x (1.610–1.663), walk fields 1.313x (1.281–1.355), attributes 1.638x (1.619–1.683), set attributes 1.705x (1.675–1.738), load only 1.828x (1.804–1.849), extract short 1.828x (1.813–1.855), mixed documents 10.006x (9.814–10.204). On the XML fixture over 60 pairs, walk fields 1.071x (1.049–1.082) and attributes 1.019x (1.001–1.033) total, with operation-only ratios at parity (1.027x, 0.788x respectively) — the remaining operation-only cost is fresh attribute-object materialization, which is the price of the cheaper reads.

## Rejected experiment: html5gum tokenizer bridge for the main parse

The diagnostics and locations parse already drives html5ever's tree builder from html5gum tokens. Driving the main parse through that bridge measured 29.8 ms on the 494 KB fixture versus 12.9 ms for the html5ever tokenizer — the bridge's per-token processing costs far more than the html5ever tokenizer it would replace. Not pursued.

## Rejected for now: replacing the scraper sink with a flat sink

An experiment with a flat `Vec`-based tree sink (no `RefCell`, no ego-tree during the parse, `Vec<(QualName, StrTendril)>` attributes, `profile_load_fixture_mid_sink`) parsed the 494 KB fixture in 8.8 ms versus 11.6 ms through scraper's `HtmlTreeSink`, suggesting roughly 2.8 ms is available from removing scraper's per-element `IndexMap` and borrow traffic. The experiment was not carried into the build: cheerox's read paths (select, render, snapshot export) read the scraper `Html` tree directly, and replacing the sink without replacing those reads would move the cost into a conversion pass. It remains the clearest measured option for pushing the 494 KB load from 12.6 ms toward 9 ms.

## Pre-existing legacy failure

`test:legacy` reports one failing test, `should render xml in html() when options.xmlMode = true passed to html()`, which expects `uppercaseattribute=""` rendering for an empty-valued mixed-case attribute. The failure reproduces identically at the PR head without any of the local changes; it is not caused by this work.


## Native global-ID export

`RoutedDocument.exportTree()` previously parsed the native JSON into JavaScript objects, allocated mapped copies with globally offset IDs, then stringified the whole tree. The native binding now has an optional `exportTreeWithOffset(base)` method that serializes the same node records and offsets IDs and links directly in Rust. Older native binaries retain the previous fallback. The paired harness normalizes each process's document base outside the timed region and checks the complete tree structure before accepting timings.

On this Windows x64 machine, 30 alternating pairs on the standard 2,000-card fixture measured 1.943x total export speed (95% bootstrap interval 1.916–1.958x) and 3.075x for the isolated operation (3.056–3.113x). Median process peak RSS fell from 301.2 MiB to 176.7 MiB. The normalized full outputs matched in every pair. This is a large improvement to full-tree export and removes the JS JSON parse/map/stringify cycle; it does not imply the same gain for ordinary load, selector, or serialization workloads.

## Fused HTML document preparation

`from_html` used to traverse the parsed tree three times: once for preorder IDs, once to build the reverse ID map, and once to count retained text and attribute bytes. It now fills all three results during one traversal, reserving both collections from the exact tree size. The HTML parser phase itself remains unchanged.

Thirty alternating paired builds with JavaScript rebuilt from the non-experimental source measured synthetic 2,000-card load-only at 1.063x (95% bootstrap interval 1.050–1.073), and load plus child walk at 1.086x (1.071–1.112); operation-only walk was 1.052x (0.987–1.090). Full outputs matched. Median process peak RSS fell 0.5 MiB for load and 1.1 MiB for the walk. On the real 151 KB page, load-only was 1.026x (0.997–1.058), while load plus serialization reached 1.045x (1.007–1.069) and operation-only serialization 1.057x (1.029–1.079). A release diagnostic measured document preparation falling from 820.5 to 252.4 µs (−69%), while parser time changed from 10.63 to 10.57 ms. Raw paired results are in `%TEMP%\cheerox-fromhtml-fused-final-ab.json` and `%TEMP%\cheerox-fromhtml-real151k-final-ab.json`.

## Starting large root walks from a snapshot

On a fresh, unchanged document with more than 4,096 slots, requesting the `children` list of the HTML root's first child now takes the already-supported packed snapshot before filling the list. This avoids a sequence of individual JSON node reads at the start of a full walk. It does not materialize node views or child arrays the caller has not requested.

Against the fused-preparation build, 30 paired runs on the 2,000-card fixture measured `walk children` at 1.030x total (1.012–1.083) and 1.152x operation-only (1.091–1.276), with exact outputs. `walk fields` was 1.019x total (0.999–1.040) and 1.035x operation-only (1.006–1.081); `children and next` was 1.017x total (1.011–1.026); `select tag` was 1.011x total (1.000–1.022). Process peak RSS for the child walk increased about 4.5 MiB in this run; other controls were effectively unchanged. The final `npm run bench:gate` passed, with the HTML 2,000-card child-walk row at 0.91x on its final retry. The gate is a regression floor, not proof of the separate 1.5x target. Raw paired results are in `%TEMP%\cheerox-walk-prepsnapshot-ab.json`.

## Rejected experiment: inline the cached children getter

Reading the cached `children` list now calls the getter helper on every access. An inline cache check intended to remove that call measured 1.008x total for the 2,000-card child walk (95% interval 0.974–1.040) and 0.987x for the walk that also reads node fields (0.975–1.025), with unchanged peak RSS. The change was removed as noise-level at best.

## Rejected experiment: inline constructor lookup in snapshot walks

Replacing the per-snapshot constructor lookup closure with direct indexing in the hot loop gave `walk children` 1.013x total (0.997–1.022) and 1.038x operation-only (1.001–1.118) in 30 pairs, but regressed `walk fields` total to 0.977x (0.897–0.994), with operation-only at parity. The optimization was removed because its small traversal-only gain did not transfer to the closely related walk and caused a repeatable total-time loss there.

Measurements below are medians from 30 alternating process pairs, with five warmups and ten measurements per process. Times include document loading unless labeled operation-only. Machine: AMD Ryzen 7 9800X3D, Windows x64, Node 24.18.0, Rust 1.99.0. Inputs are synthetic; these results are not universal. Bootstrap intervals characterize sampled pairs, not machine-to-machine uncertainty.

| Case | Comparison | Before ms | After ms | Paired ratio (95% bootstrap) |
| --- | --- | ---: | ---: | ---: |
| 200-card HTML, 50-field extraction | prior Cheerox -> compiled plan | 2.22 | 2.03 | 1.087x (1.067–1.111) |
| 200-card HTML, 50-field extraction | compiled plan -> selector reuse | 2.05 | 1.43 | 1.427x (1.408–1.457) |
| 2,000-card HTML, 50-field extraction | prior Cheerox -> compiled plan + selector reuse | 19.18 | 13.28 | 1.460x (1.427–1.495) |
| 2,000-card HTML, short extraction | selector reuse -> first-match | 13.28 | 13.11 | 1.022x (1.003–1.038) |
| 2,000-card HTML, short extraction, operation-only | selector reuse -> first-match | — | — | 3.732x (3.669–3.841) |
| 2,000-card HTML, 50-field extraction | Cheerio 1.2 -> first-match | 11.41 | 13.16 | 0.875x (0.841–0.887) |
| 2,000-card HTML, short extraction | Cheerio 1.2 -> first-match | 12.34 | 13.16 | 0.937x (0.887–0.955) |
| 200-card HTML, mixed documents | previous Cheerox -> positional + two-node sort | 5.99 | 2.66 | 2.244x (2.185–2.289) |
| 200-card HTML, mixed documents | Cheerio 1.2 -> optimized Cheerox | 2.80 | 2.74 | 1.022x (0.966–1.067) |
| 2,000-card HTML, load only | before -> skip unneeded sink string allocation | 12.90 | 12.43 | 1.032x (1.010–1.054) |
| 200-card HTML, load only | before -> skip unneeded sink string allocation | 1.23 | 1.19 | 1.031x (1.024–1.056) |
| 2,000-card HTML, load only | before -> skip unneeded text copies | 12.45 | 12.08 | 1.027x (1.010–1.045) |
| 200-card HTML, load only | before -> skip unneeded text copies | 1.18 | 1.14 | 1.037x (1.016–1.056) |

The 1.5x target versus Cheerio remains unmet in these end-to-end cases. The large extraction results show that load dominates after query optimization; this requires independent profiling rather than extrapolating from the operation-only result. The full corpus described in `bench/libraries/README.md` was not present for these measurements; a separate small public-page sample is reported below. Full raw paired data for these local runs is in the system temporary directories; regenerate with `bench/compare-builds.mjs` and independently built artifacts as described in `bench/COMPARE.md`.

For a separate Rust-only diagnostic, `cargo test --release profile_document_load_phases -- --ignored --nocapture` measured the 2,000-card HTML tokenizer/tree builder at 10.86 ms and subsequent document preparation at 0.80 ms (individual phase medians, 30 samples after five warmups). This diagnostic does not include JavaScript or N-API and should not be added to the end-to-end medians above.

## Public-page sample

Ten pages were fetched from the first WARC of Common Crawl `CC-MAIN-2025-38` using `node bench/corpus/fetch.mjs <directory> 10`. The following three were chosen by size; full serialized output was verified equal between builds. Each row uses 30 alternating process pairs and includes loading and serialization.

| Page | Bytes | SHA-256 | Previous -> text-copy optimization | 95% bootstrap |
| --- | ---: | --- | ---: | ---: |
| 00002.html | 8,088 | `0abf058611ec46900996ac9f076f7365974de6dcb63735e5c466142f12c24fc6` | 0.30 -> 0.29 ms; 1.064x | 1.014–1.125 |
| 00007.html | 38,344 | `148b87a9f56febfe707b884abf964fa4d326156a1df01080e145c6c73bcc17d3` | 0.86 -> 0.81 ms; 1.059x | 1.007–1.120 |
| 00008.html | 151,002 | `4583507d8dafaa7c8748bc14fe7ccdb57906733373ff6951e8991cea06e55581` | 3.14 -> 3.01 ms; 1.031x | 1.017–1.074 |

For `00008.html`, Cheerio 1.2 and the optimized build produced equal serialized output: 5.93 versus 2.98 ms, paired median 2.003x (1.882–2.076). This is one page and one operation, not a general performance claim. Raw pages were left outside the repository.

## Ten-page comparison with Cheerio 1.2

Each row uses 30 pairs, five warmups and ten samples per process. Times include loading, in milliseconds. Extraction reads `h2` text and the first `a` href; serialization compares the entire HTML output. Output equivalence includes undefined values via V8 serialization. All pages came from the same first WARC of CC-MAIN-2025-38; this small, non-random sample is not representative of the web.

| Page | bytes | SHA-256 | Extraction Cheerio → Cheerox ms; ratio (95% CI) | Serialization Cheerio → Cheerox ms; ratio (95% CI) |
| --- | ---: | --- | --- | --- |
| 00000.html | 15936 | `f34fa83e85ec2d253442afef1dcef4de33df0469f7b595c39ac70d385bab7d6d` | 1.09 → 0.59; 1.852x (1.745–1.956) | 1.29 → 0.59; 2.118x (2.010–2.238) |
| 00001.html | 64815 | `847ef0e453f5ee7cea60d0929755c2f34131aeaaf47117a0396bf122f0222739` | 1.73 → 0.59; 3.017x (2.871–3.114) | 1.88 → 0.64; 2.894x (2.809–3.023) |
| 00002.html | 8088 | `0abf058611ec46900996ac9f076f7365974de6dcb63735e5c466142f12c24fc6` | 0.67 → 0.30; 2.220x (2.051–2.335) | 0.69 → 0.30; 2.345x (2.240–2.517) |
| 00003.html | 8944 | `f8c1f36e294fd59b0f4e67b8b0038c047b5f6380f441c0377fff12aea04f2a05` | 0.67 → 0.32; 2.096x (1.977–2.279) | 0.73 → 0.31; 2.398x (2.322–2.452) |
| 00004.html | 16978 | `d3f73a8e4fde23f553a33dd46240adaa416611b4d8f06a53bdd8f641c1236a9e` | 1.05 → 0.54; 1.889x (1.854–2.020) | 1.22 → 0.56; 2.213x (2.142–2.303) |
| 00005.html | 17538 | `dc078bd768912410707c27c40ec48e6cef2009d4d183e7a6db34fab13383cafd` | 1.05 → 0.55; 1.965x (1.848–2.003) | 1.23 → 0.56; 2.208x (2.180–2.268) |
| 00006.html | 16899 | `34583cea8ee06dd7dcbdc93dba98f533e7a686c8933cd95a4482a581f062cc6d` | 0.98 → 0.53; 1.818x (1.751–1.887) | 1.15 → 0.56; 2.056x (1.993–2.158) |
| 00007.html | 38344 | `148b87a9f56febfe707b884abf964fa4d326156a1df01080e145c6c73bcc17d3` | 1.31 → 0.76; 1.773x (1.613–1.822) | 1.55 → 0.78; 1.996x (1.960–2.081) |
| 00008.html | 151002 | `4583507d8dafaa7c8748bc14fe7ccdb57906733373ff6951e8991cea06e55581` | 4.51 → 2.67; 1.677x (1.659–1.731) | 5.78 → 3.02; 1.934x (1.902–1.954) |
| 00009.html | 10844 | `df51afca87877da36fe05b53816539b8602cf1c57802bb33296d8b9cc4cbc242` | 0.67 → 0.32; 2.166x (2.045–2.315) | 0.79 → 0.31; 2.565x (2.401–2.707) |

## Branch regression controls

Against the build at the PR head before the current local changes, 30 alternating pairs per row; loading is included. These are one-machine synthetic measurements. Intervals containing 1 are inconclusive; they do not establish absence of regressions.

| Input | Operation | Baseline ms | Candidate ms | Paired ratio (95% bootstrap) |
| --- | --- | ---: | ---: | ---: |
| HTML, 200 cards | select tag | 1.29 | 1.23 | 1.047x (1.034–1.069) |
| HTML, 200 cards | materialize selection | 1.53 | 1.40 | 1.107x (1.046–1.135) |
| HTML, 200 cards | filter complex | 1.44 | 1.38 | 1.053x (1.036–1.083) |
| HTML, 200 cards | attributes | 1.61 | 1.45 | 1.127x (1.110–1.151) |
| HTML, 200 cards | set attributes | 1.44 | 1.37 | 1.083x (1.047–1.097) |
| HTML, 200 cards | data scalar | 2.36 | 2.27 | 1.038x (1.022–1.048) |
| HTML, 200 cards | data values | 1.70 | 1.62 | 1.044x (1.022–1.063) |
| HTML, 200 cards | extract short | 1.34 | 1.24 | 1.089x (1.067–1.111) |
| HTML, 200 cards | mixed documents | 14.66 | 2.58 | 5.672x (5.649–5.792) |
| XML, 200 cards | select tag | 0.54 | 0.51 | 1.034x (0.990–1.147) |
| XML, 200 cards | materialize selection | 0.80 | 0.70 | 1.055x (1.022–1.174) |
| XML, 200 cards | filter complex | 0.60 | 0.61 | 1.005x (0.957–1.134) |
| XML, 200 cards | attributes | 0.71 | 0.70 | 1.088x (0.968–1.175) |
| XML, 200 cards | set attributes | 0.56 | 0.59 | 0.977x (0.902–1.022) |
| XML, 200 cards | data scalar | 1.31 | 1.25 | 1.035x (0.989–1.122) |
| XML, 200 cards | data values | 0.54 | 0.54 | 1.013x (0.985–1.067) |
| XML, 200 cards | extract short | 0.52 | 0.52 | 1.014x (0.971–1.090) |
| XML, 200 cards | mixed documents | 10.34 | 0.95 | 11.241x (10.573–11.300) |

XML set attributes was repeated with 60 pairs: 1.010x (0.895–1.076), still inconclusive. The repeated-node snapshot guard was subsequently refined; final-build controls are reported below.

## Final-build XML control, 2,000 cards

The final ordered snapshot guard was measured against the PR-head build in 30 alternating pairs. Total-time ratios were: tag selection 1.018x (1.004–1.039), materialization 1.032x (0.994–1.111), attributes 1.031x (0.993–1.081), set attributes 1.003x (0.962–1.028), scalar data 1.001x (0.965–1.077), and short extraction 0.988x (0.932–1.008). The first short-extraction run showed an operation-only ratio of 0.897x (0.847–0.971). A separate 60-pair repetition measured 0.995x (0.954–1.023) total and 0.971x (0.896–1.042) operation-only. The repeat does not establish a regression or rule one out; more independent measurements are needed before claiming regression-free performance. The benchmark outputs matched in every pair.

## Final-build HTML control, 2,000 cards

These measurements compare the final build to the PR-head build with 30 alternating pairs. Times include loading. Peak RSS is the process-wide high-water mark over warmup and measurements, not memory attributed to the operation.

| Operation | Baseline ms | Candidate ms | Paired ratio (95% bootstrap) | Operation-only ratio (95% bootstrap) |
| --- | ---: | ---: | ---: | ---: |
| Load only | 13.26 | 12.84 | 1.053x (1.025–1.081) | — |
| Materialize selection | 15.41 | 14.85 | 1.052x (1.008–1.090) | 1.172x (1.124–1.338) |
| Materialize repeated reference | 13.89 | 13.28 | 1.050x (1.022–1.092) | 0.998x (0.959–1.039) |
| Attributes | 15.91 | 15.76 | 1.020x (0.997–1.044) | 1.097x (1.051–1.182) |
| Extract 50 fields | 20.82 | 13.79 | 1.537x (1.487–1.555) | 26.774x (24.192–28.652) |
| Extract two fields | 13.64 | 12.70 | 1.073x (1.055–1.116) | 3.273x (3.101–3.606) |

The 50-field extraction process high-water RSS medians were 118.6 MiB before and 151.3 MiB after. This coarse measurement includes all warmups, loading and garbage collection; it warrants independent memory profiling rather than attributing the difference to extraction itself.

Mixed-document selection measured 174.87 → 27.54 ms, 6.659x (6.478–6.752) including loading and 11.550x (11.212–12.248) operation-only; process peak RSS medians were 416.6 → 193.1 MiB. Outputs matched across all pairs.

The wide-extraction repeat gave 1.591x (1.565–1.623) total and process high-water RSS medians of 124.1 → 150.9 MiB. In a separate single-process diagnostic with 15 loads and extractions, explicitly calling `global.gc()` after each iteration yielded peak RSS of 75.7 → 74.0 MiB; without per-iteration GC it yielded 123.4 → 151.1 MiB. This points to GC timing as a possible contributor but does not establish causation or replace a memory profile. The forced-GC diagnostic is not used for timing comparisons.

## Simple tag selection without result sorting

For an unqualified lowercase tag selector at the document root, the parse-tree selector traversal already returns each matched element once in document order. `select_ids` now skips the sort/dedup pass only for that narrow selector form. Compound selectors, contexts, mutated/detached trees, uppercase names, and other special cases retain the existing native or sort/dedup paths. A Rust regression assertion covers document order for the root `p` query; existing selector and compatibility suites exercise the other paths.

Compared with the immediately preceding build, 30 paired local runs showed only a small, workload-dependent change. On synthetic HTML with 2,000 cards, tag selection including load improved 1.008x (0.996–1.045); operation-only was 1.023x (0.972–1.048). On a 151 KB real page, end-to-end tag selection was 1.010x (0.995–1.019), while operation-only was 1.006x (0.962–1.057). Short extraction on the real page was 0.994x (0.953–1.032). Intervals overlap parity, so the result does not establish a reliable performance gain. The change is retained as a low-risk removal of redundant work, not as evidence toward the 1.5x target. Build snapshots and paired measurements are in the system temporary directories `cheerox-simple-tag-sort` and `cheerox-render-options-fast`.

## Full-tree JavaScript walk diagnosis

Earlier performance-gate runs found HTML `walk children` below parity at 2,000 cards (0.85x including its separate load median; subsequent retries were 0.77x and 0.76x). A non-quick 21-sample run reproduced 0.77x at 2,000 cards and 0.83x at 200 cards. A later gate run also flagged `parent and siblings` at 0.85x. The child walk materializes JavaScript node views and child lists on demand; a V8 profile sampled view construction and snapshot filling but did not support retaining micro-optimizations in that loop. Fusing native document preparation later lifted the gate's end-to-end walk above its 0.9x floor, as recorded above.

The first snapshot experiment left the 2,000-card end-to-end walk at 0.78x (versus 0.77x before) and was removed; record reads already trigger the existing snapshot heuristic earlier. Two variants replacing the two-step child-view construction (`Object.create` plus `defineProperty`) with `Object.create` descriptor maps regressed `walk children` to 0.83x total and 0.55x operation-only, and 0.84x total / 0.69x operation-only for `walk fields` in 30 paired rounds. Both were removed. Short extraction and tag selection were effectively unchanged. The paired output-equality checks passed in every case. Raw pairs are in `%TEMP%\cheerox-walk-view-create-ab-precomputed.json`.

Inlining the child-list cache check in the `children` accessor improved `walk children` just 1.013x (0.997–1.033) in 60 pairs, but regressed `walk fields` to 0.979x (0.965–0.994) total and 0.947x (0.924–0.980) operation-only. Extraction was 1.003x (0.992–1.008), and tag selection was 0.991x (0.973–1.010). This fast path was removed because it caused a repeatable regression in a related public traversal. Raw pairs are in `%TEMP%\cheerox-child-getter-fastpath-60.json`.

To diagnose the gate's selection-chain cases with the same paired harness, `parent and siblings`, `parents count`, and `children and next` were added as selectable cases to `bench/compare-builds.mjs`. A constructor experiment that skipped undefined selection fields improved `parent and siblings` by 1.028x operation-only (1.002–1.043) in one 60-pair run, but total was 0.995x (0.986–1.008), process peak RSS rose 5.3–8.2 MiB, and a repeat measured the operation at 1.001x (0.977–1.046). `parents count` total regressed to 0.982x (0.971–0.994); load-only was 0.991x (0.981–1.000); short extraction was 0.977x (0.960–1.001). This variant was removed. Sharing `DOCUMENT` and `API` from the per-document selection prototype also failed to improve the chains: `parent and siblings` operation-only was 0.968x (0.938–1.009), `parents count` was 1.010x (0.995–1.031), and `walk children` was 1.005x (0.958–1.036); load-only was 0.985x (0.967–1.006). It was removed. Compared outputs were equal. Raw data: `%TEMP%\cheerox-selection-fields-sparse-60.json`, `%TEMP%\cheerox-selection-fields-load-repeat-60.json`, and `%TEMP%\cheerox-selection-prototype-context-60.json`.

Reducing `plainSelectionLimit` from 16 to 1, 2, or 3 also failed to deliver a clean tradeoff. Limit 1 significantly regressed `parents count` total (0.968x, 0.941–0.993) and raised the `parent and siblings` process peak by about 33 MiB. Limit 2 left `parent and siblings` at 0.989x total and raised its peak by about 31 MiB; its 3.6% operation-only improvement on `children and next` (1.016–1.064) did not transfer to total time. Limit 3 regressed `select tag` operation-only to 0.974x (0.945–0.995). These thresholds were removed.

Limit 5 is retained provisionally: 60 paired rounds measured `load only` 1.011x (0.994–1.019), `parent and siblings` 1.005x total (0.995–1.013) and 1.009x operation-only (0.980–1.028), `parents count` 1.019x total (1.008–1.024) and 0.990x operation-only (0.971–1.020), `children and next` 1.000x total (0.994–1.013) and 1.001x operation-only (0.982–1.019), and `select tag` 1.010x total (1.002–1.022) and 1.014x operation-only (0.995–1.061). The process peak fell 7.1 MiB for `parent and siblings` and 5.3 MiB for `children and next`; these are coarse, process-level measurements. No output differences occurred. At that checkpoint, the gate still failed on the HTML 2,000-card child walk; this was later brought above the 0.9x floor by fused document preparation. Raw paired data is in `%TEMP%\cheerox-plain-selection-limit-5-60.json`; threshold sweeps are in similarly named `cheerox-plain-selection-limit-{1,2,3}-30.json` files.

The child-list cache stores the same array in both `VIEW_CHILDREN` and `VIEW_CHILD_TARGET`. A 60-pair test unified those references and removed one redundant per-node symbol write. Results were inconclusive and effectively parity: `walk children` 1.002x total (0.980–1.024) and 0.979x operation-only (0.924–1.027); `walk fields` 0.991x total (0.971–1.003) and 0.974x operation-only (0.951–1.007); short extraction 0.995x (0.975–1.013); materializing a selection 0.992x (0.985–1.016). Process peak RSS was effectively unchanged. The change was removed despite the neutral timing: the registered symbol also lets an older installed copy reuse this per-node cache, and preserving that cross-copy behavior is more important than an unmeasurable saving. Raw pairs are in `%TEMP%\cheerox-child-target-unified-60.json`.

## Final-build controls, 200 cards

Thirty alternating pairs per case, including load; 95% bootstrap intervals. Results were exactly equal across builds. Intervals spanning 1 are inconclusive.

| Mode | Operation | Baseline ms | Candidate ms | Paired ratio (95% CI) |
| --- | --- | ---: | ---: | ---: |
| HTML | select tag | 1.34 | 1.25 | 1.066x (1.043–1.142) |
| HTML | materialize selection | 1.50 | 1.37 | 1.110x (1.084–1.132) |
| HTML | filter complex | 1.43 | 1.37 | 1.045x (1.030–1.072) |
| HTML | attributes | 1.62 | 1.46 | 1.109x (1.082–1.144) |
| HTML | set attributes | 1.42 | 1.34 | 1.065x (1.030–1.086) |
| HTML | data scalar | 2.37 | 2.28 | 1.048x (1.014–1.075) |
| HTML | data values | 1.65 | 1.57 | 1.050x (1.029–1.070) |
| HTML | extract short | 1.34 | 1.21 | 1.120x (1.083–1.150) |
| HTML | mixed documents | 14.66 | 2.57 | 5.722x (5.659–5.822) |
| XML | select tag | 0.43 | 0.43 | 0.994x (0.968–1.035) |
| XML | materialize selection | 0.60 | 0.60 | 1.016x (0.978–1.052) |
| XML | filter complex | 0.49 | 0.49 | 0.999x (0.926–1.025) |
| XML | attributes | 0.61 | 0.62 | 0.984x (0.975–1.008) |
| XML | set attributes | 0.54 | 0.54 | 1.026x (0.965–1.050) |
| XML | data scalar | 1.20 | 1.12 | 1.083x (1.024–1.128) |
| XML | data values | 0.50 | 0.49 | 1.009x (0.991–1.031) |
| XML | extract short | 0.47 | 0.47 | 0.998x (0.963–1.039) |
| XML | mixed documents | 9.72 | 0.87 | 11.206x (10.910–11.343) |

## Rejected experiment: larger initial HTML tree reservation

Increasing the initial node cap from 4,096 to 16,384 gave 1.023x (1.006–1.045) for synthetic 2,000-card load in 30 pairs, but a long, mostly-text input gave 0.962x (0.935–0.975). On a 151 KB real page, load was 1.001x (0.987–1.044). A follow-up variant only increased the cap after detecting 2,048 markup delimiters; in 60-pair runs it measured 0.989x (0.960–1.001) on the dense synthetic page and 0.992x (0.962–1.017) on the mostly-text input. These results do not justify the change; both variants were removed. A first 30-pair run suggested a serialization-only loss with the unconditional variant, but its 60-pair repeat was inconclusive at 1.014x (0.970–1.071). All compared outputs matched. Input and artifact hashes and raw pairs were recorded in the system temporary directory `cheerox-capacity-16384` or `cheerox-capacity-dense`.

## Rejected experiment: mimalloc on Windows

On Windows x64, an independent build using mimalloc with its default purge policy improved 2,000-card HTML load 1.127x (1.100–1.162) and XML load 1.601x (1.514–1.659), with 30 alternating pairs. A 151 KB real page improved load 1.103x (1.083–1.117). However, a separate 12-pair sustained XML materialization probe, with ten batches of ten documents, explicit GC and event-loop delays, showed median RSS after the last batch of 124.7 MiB versus 88.1 MiB before. This is a process-level measurement on one machine, not proof of a leak.

Using `MIMALLOC_PURGE_DELAY=0` reduced the same sustained RSS to 89.2 versus 87.0 MiB and retained a 1.461x (1.394–1.530) XML load improvement, but an independent build defaulting to immediate purge regressed serialization-only on the real page: 0.776x (0.766–0.802) in a 60-pair repeat; end-to-end was 0.997x (0.979–1.011). With a five-millisecond delay, sustained RSS was 119.1 versus 86.1 MiB, and the initial 30-pair serialization-only ratio was 0.948x (0.878–1.000). The allocator variants were therefore removed rather than trading one regression for another. All compared outputs matched. The sustained probe uses 12 process pairs, not the 30 or more used for timed comparisons; raw data and artifact hashes remain in the system temporary directories `cheerox-mimalloc-win-experiment` and `cheerox-mimalloc-win-tuned`.

## Inline child IDs in mutable trees

The mutable arena now stores up to two child IDs inline and retains the same JSON array representation. This avoids a separate allocation for the common small child list. Against the immediately preceding build, the final candidate on Windows x64 produced equal outputs in 30 alternating pairs on synthetic 2,000-card XML: load 1.082x (1.040–1.101), load plus serialization 1.070x (1.037–1.095), load plus materialization 1.058x (1.032–1.130), and load plus short extraction 1.054x (1.018–1.083). Median process peak RSS for those cases decreased by approximately 0.7–3.5 MiB. In a 12-pair sustained XML materialization probe, median final RSS was 85.5 versus 86.0 MiB, with process peaks 126.7 versus 129.1 MiB. These memory observations are coarse process-level measurements from one machine.

A 60-pair HTML load control measured 0.993x (0.987–1.002), inconclusive. An earlier candidate that enabled an additional dependency feature measured 0.983x (0.967–0.999) on the same synthetic control; the final candidate avoids that feature. Further independent HTML measurements are needed to rule out a small loss. Raw pairs and build hashes are in the system temporary directory `cheerox-inline-children-v2`.

## Avoiding closing-tag copies

Closing-tag comparison now borrows the original source when the UTF-16 span lies on UTF-8 boundaries and does not require case conversion; other cases use the previous owned conversion. Compared with the inline-children build on this Windows machine, 30 alternating pairs on 2,000-card XML showed 1.063x (1.021–1.107) for loading and 1.065x (1.052–1.094) for load plus short extraction. At 200 cards, XML load was 1.131x (1.094–1.195). With the public htmlparser2 configuration `{ xml: { xmlMode: false } }`, large load was 1.076x (1.055–1.128) and load plus serialization 1.076x (1.043–1.107). The standard HTML large control was inconclusive at 0.998x (0.992–1.015) for load and 0.992x (0.975–1.024) for load plus serialization. Every compared output matched. Source and build hashes and raw pairs are in `cheerox-close-borrow` in the system temporary directory.

While adding compatibility coverage, a pre-existing discrepancy was found with the internal option `{ _useHtmlParser2: true }`: for `<div>Ω<br></div>`, Cheerio 1.2 produces `<div>Ω<br></br></div>` while both the preceding build and this candidate produce `<div>&#x3a9;<br></div>`. The public configuration `{ xml: { xmlMode: false } }` produces matching output for that example. The discrepancy was not caused by this optimization; it was subsequently fixed as described below.

## Rendering option compatibility

`$.html()` now merges rendering options in the same order as Cheerio, and parse5-style rendering recognizes a void element only when its namespace is HTML. This fixes the internal htmlparser2 example above and the rendering of imported void elements without a namespace. Differential tests cover the internal flag, public HTML and XML settings, rendering overrides, and imported nodes.

A first implementation performed extra option copies on every call; 60 pairs on 200-card HTML showed operation-only 0.907x (0.880–0.990), so it was replaced with a fast path for already-normalized common settings. The final implementation measured 1.000x (0.980–1.033) total and 1.020x (0.973–1.088) operation-only; both intervals include parity. On the public htmlparser2 configuration, total was 1.006x (0.993–1.031) and operation-only 1.003x (0.991–1.018). These are one-machine synthetic measurements and do not rule out small losses. Raw results and independently built artifact hashes are in `cheerox-render-options-fast` in the system temporary directory.

## Extraction stages after load, real 151 KB page

A direct operation-only probe parsed `00008.html` once per engine, then timed each operation in 30 GC-separated samples after ten warmups. Selector `a` took 0.119 ms with Cheerox and 0.204 ms with Cheerio. Reading already materialized `href` strings directly took 0.009 and 0.011 ms. The 50-field `extract` map took 0.248 and 0.545 ms (2.20x); the two-field map took 0.089 and 0.142 ms (1.60x). The sample times suggest selector work and extract-plan setup/transport, rather than attribute reads, dominate this operation. This probe is diagnostic: its timing method differs from the paired end-to-end harness, so these ratios should not replace the paired results above.


## Rejected experiment: `new` for modern node views

A first `new`-based candidate initialized `this` but omitted the required own, enumerable `children` descriptor. Though the comparison harness output matched, two `domhandler/htmlparser2` shape-compatibility tests failed, so its apparent 1.070x total / 1.447x operation-only child-walk speedup is invalid and excluded. A corrected variant defined that descriptor on `this`; the targeted compatibility suite passed (20/20). In 30 paired runs against the same snapshot build, corrected `walk children` was 1.013x total (0.984–1.039) and 1.011x operation-only (0.966–1.095), while `walk fields` regressed to 0.958x total (0.935–1.043) and 0.880x operation-only (0.842–0.948). Peak RSS moved inconsistently (+32.4 MiB for child-only walk, −5.3 MiB for fields). The corrected experiment was also reverted because it did not improve both traversal workloads.

## Latest full-traversal control

After reverting the `new` constructor experiment and rebuilding, the non-quick 21-sample HTML operations benchmark measured generated-2000 `walk children` at 0.48x operation-only / 0.83x with load, and `walk with fields` at 0.26x / 0.60x. At generated-200, the corresponding end-to-end ratios were 0.80x and 0.64x. A separate quick gate run was noisier and failed its 0.9x HTML child-walk floor at 0.89x after retries. This confirms full JS tree traversal remains a real gap; the constructor experiment's strong isolated speedup cannot be retained due compatibility failures. The 1.5x target is not met for this workload.

The latest final-state `npm run bench:gate` run failed: after quick retries, HTML `walk children` on generated-2000 was 0.85x with load, below the 0.9x parity floor. This gate result is consistent with the non-quick paired run showing the workload remains slower end to end; the previous gate pass at 0.91x was too close to its floor to establish robustness.

## Rejected experiment: specialize snapshot child filling

`fillFromSnapshot` was given a separate loop for the common case with no adapter nodes, weak views, or pending roots, to remove those checks from each child iteration. Targeted DOM compatibility and mutation tests passed. Against the unchanged root-snapshot build, 30 paired runs on 2,000-card HTML measured `walk children` at 1.011x total (0.996–1.019) and 1.013x operation-only (0.971–1.099); `walk fields` at 1.004x total (0.983–1.036) and 1.035x operation-only (0.984–1.070); tag selection 0.995x total (0.970–1.029); and short extraction 1.000x total (0.985–1.010). Output equality held, but intervals include parity and the extra path did not deliver a reliable gain, so it was removed.

## Rejected experiment: object-literal node views

The modern view factory was changed to create a typed object literal with its per-type prototype and six internal symbol fields, then add the own enumerable `children` accessor. This was intended to replace `Object.create` plus repeated symbol assignments. Targeted DOM compatibility tests passed, but 30 paired 2,000-card HTML runs showed large regressions: `walk children` 0.616x total (0.607–0.628) / 0.278x operation-only (0.269–0.292), `walk fields` 0.699x / 0.500x operation-only (0.482–0.516), and selection materialization 0.926x / 0.645x operation-only. Peak RSS fell by about 22 MiB on child walk and 81 MiB on field walk; short extraction was neutral. The candidate was removed because its time cost is unacceptable despite lower coarse peak RSS.

## Rejected experiment: flatten modern view prototypes

Modern no-location views were temporarily created directly on the existing DOM class prototypes, with routed accessors installed there instead of on one intermediate prototype per node shape. The prototype change exposed a constructor-adoption edge: `adoptObject` queried inherited `attribs` before attaching native state, so the experiment also used an own-property check to preserve attribute-object prototypes safely. Targeted DOM, native-hook, cross-document and tree-selection tests passed (66 tests total). In 30 paired 2,000-card runs, `walk children` was 0.999x total (0.985–1.017) / 1.038x operation-only (0.975–1.076); `walk fields` 1.010x (0.989–1.046) / 1.029x operation-only (0.989–1.094); selection materialization 0.976x total (0.965–1.004); repeated materialization 0.990x; short extraction 0.997x; and attributes 0.993x. RSS was mostly unchanged or slightly higher. The shared-prototype mutation and adoption change were removed because traversal remained at parity and selection materialization regressed slightly.

## Rejected experiment: fixed-shape attribute proxy handler

The attribute proxy handler was changed from an object inheriting shared write traps with six follow-up assignments to one fixed-shape object literal carrying own trap references and per-view state. The focused native-hook, cross-document, selection and snapshot suites passed (58 tests). Thirty paired 2,000-card runs showed no reliable gain: `walk fields` 0.985x total (0.966–1.005), attributes 1.012x (0.979–1.039), `set attributes` 0.987x (0.969–1.012), wide extraction 1.008x (0.988–1.028), and selection materialization 0.989x (0.973–1.025). It was reverted.

## Rejected experiment: omit unused symbols on leaf views

Constructors temporarily skipped the attribute-cache symbol on non-elements and both child-list cache symbols on leaf nodes. This retained DOM shape and passed 70 focused tests, but 30 paired runs on 2,000-card HTML regressed `walk children` to 0.963x total (0.936–1.015) / 0.980x operation-only (0.928–1.006) and `walk fields` to 0.930x total (0.895–1.008) / 0.895x operation-only (0.843–1.023). Selection materialization was near parity, as were attribute and extraction controls. The variant was reverted.
