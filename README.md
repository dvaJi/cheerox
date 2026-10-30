<p align="center">
  <a href="https://context.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/context-logo-white.svg">
      <img src="assets/context-logo.svg" alt="Context.dev" width="240">
    </picture>
  </a>
</p>

<h1 align="center">rusteerio</h1>

<p align="center">Cheerio's API on a Rust engine, with parallel workers and zero npm dependencies.</p>

**Heavily inspired by [Cheerio](https://cheerio.js.org/)** and its familiar,
flexible HTML API. Built by the **[context.dev team](https://context.dev)**.

[![CI](https://github.com/context-dot-dev/rusteerio/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/context-dot-dev/rusteerio/actions/workflows/ci.yml)
[![Cheerio tests](https://img.shields.io/badge/Cheerio_tests-777_passing-brightgreen)](test/upstream/README.md)
[![npm version](https://img.shields.io/npm/v/rusteerio)](https://www.npmjs.com/package/rusteerio)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Built by context.dev](https://img.shields.io/badge/built_by-context.dev-202020)](https://context.dev)
[![Runtime dependencies](https://img.shields.io/badge/npm_runtime_dependencies-0-brightgreen)](package.json)

Cheerio's interface, a Rust HTML/XML engine, and configurable parallel workers.
Rusteerio keeps the DOM, parsing, selectors, mutations and serialization in a
native addon, with **zero npm runtime dependencies**. TypeScript supplies the
API, stable node views, user callbacks and Node.js I/O.

## Why this exists

Cheerio makes server-side HTML processing approachable. We wanted to keep that
experience while making large scraping and extraction workloads faster and
giving applications a way to move CPU work off the JavaScript main thread.

Rusteerio combines a familiar synchronous API with additional async batch APIs.
Use the synchronous API for ordinary document work, or set a worker limit when
processing many documents. The implementation is independent of Cheerio's
JavaScript engine; Cheerio is a development dependency used to check behavior.

## Installation

The npm package name is **`rusteerio`**:

```sh
npm install rusteerio
```

Node.js **20.19 or newer** is required. Release tarballs bundle native binaries
for macOS arm64/x64, Linux glibc and musl arm64/x64, and Windows arm64/x64. Supported
platforms need no Rust installation and no install script. For a source checkout,
follow [Development](#development).

Linux GNU binaries require **glibc 2.28 or newer**. Musl binaries are tested on
**Alpine 3.24**. Linux also needs `libgcc_s.so.1`; minimal Alpine images can
install it with `apk add --no-cache libgcc`.

## Familiar Cheerio API

```ts
import * as rusteerio from 'rusteerio';

const $ = rusteerio.load('<ul><li class="fruit">Apple</li></ul>');

$('li').addClass('fresh').attr('data-id', '1');
console.log($('.fruit').text()); // Apple
console.log($.html());
```

CommonJS works too:

```js
const rusteerio = require('rusteerio');
const $ = rusteerio.load('<h1>Hello</h1>');
console.log($('h1').text());
```

The API includes selectors and traversal, DOM insertion and removal, cloning,
attributes and properties, classes, styles, form values and serialization,
HTML/XML output, extraction, buffers, streams and URL loading. The
`rusteerio/slim` and `rusteerio/utils` entry points are included. TypeScript
declarations are self-contained, with ESM and CommonJS support.

XML parsing preserves case and supports CDATA:

```ts
const $ = rusteerio.load('<Root><Item Id="1"/></Root>', { xml: true });
console.log($('Item').attr('Id')); // 1
```

## Parallel extraction and worker limits

```ts
import { configureWorkers, loadAsync, loadAll, extractAll, workerPoolInfo } from 'rusteerio';

// Set one process-wide CPU budget before starting asynchronous native work.
configureWorkers({ threads: 4 });

const $ = await loadAsync(largeHtml);
const documents = await loadAll(htmlPages, { threads: 4 });

const rows = await extractAll(htmlPages, {
  title: 'h1',
  headings: ['h2'],
  links: [{ selector: 'a', value: 'href' }],
}, { threads: 4 });

console.log(workerPoolInfo()); // configured budget, active work and peak usage
```

| API | Result | Native work |
| --- | --- | --- |
| `loadAsync(content, options?, isDocument?)` | `Promise<CheerioAPI>` | Parses off-thread |
| `loadAll(strings, options?, isDocument?)` | `Promise<CheerioAPI[]>` | Parses documents in parallel |
| `extractAll(strings, map, options?)` | Extracted objects in input order | Parses and extracts in parallel |

`configureWorkers({ threads: 4 })` (or `configureWorkers(4)`) caps active native
CPU work across concurrent batches, single-document async parsing and streams.
Set it before starting asynchronous native work. You can also set
`RUSTEERIO_THREADS=4` before starting Node. The default is available CPUs, capped
at 256. Configuration accepts integers from **1 to 256**; changing the budget
after work starts throws. Reapplying the same budget is allowed.

The per-batch `threads` option can lower a batch's parallelism within that shared
budget. Results preserve input order. `{ xml: true, threads: 4 }` works too.
`workerPoolInfo()` reports `threads`, `activeBatches`, `activeWorkers` and
`peakActiveWorkers`. The cap measures active CPU work; streams can have additional
parked threads waiting for input or a JavaScript callback. Synchronous calls use
idle workers of the same pool for large internal work, such as copying a large
parse tree into the mutable tree on its first write or freeing a large tree, and
never wait for a busy worker. Before the pool exists, one background thread frees
large trees, so collecting a large document does not stall JavaScript.

Synchronous `load()`, queries, mutations and serialization **block the main
thread** while they run. The async APIs move heavy native work onto workers;
input copying, result decoding and user callbacks still run on the JavaScript
thread. Pure extraction maps, including nested maps, execute entirely in Rust
before their results are decoded. Callback extraction yields between groups of
elements, preserving closures and callback order. A single expensive callback
can still block the main thread.

## Streams and parser extensions

`stringStream()` incrementally parses strings in Rust. `decodeStream()` sniffs a
bounded encoding prefix and decodes incoming byte chunks; `fromURL()` feeds the
same parser as the response arrives. Writable backpressure bounds queued input.
HTTP loading supports redirects, abort signals, header/body timeouts and response
size limits. A caller can supply an Undici-compatible dispatcher.

Custom HTML5 `treeAdapter` methods participate in tree construction, and
`onParseError` receives parser diagnostics. The HTML/XML tokenizer's custom
`Tokenizer` constructor and callbacks are supported as well. User code runs in
JavaScript. Arbitrary custom tokenizers can refer to earlier source offsets, so
that path retains the source until completion. Source locations retain extra
metadata; avoid enabling them when you do not need it.

DOM views expose writable Cheerio-compatible fields and stable identity. Parent
nodes have an own `children` accessor for compatibility with `domhandler` helpers;
other fields are accessors on the prototype. Read `node.attribs`, `node.children`
and the other fields directly. Change the tree
through the Cheerio API or by assigning node fields: writing an index or the
`length` of a `children` array changes only that array. Removed branches stay
usable while their selections or nodes are held, and a held node keeps its
document alive; unreachable branches can be reclaimed and their Rust storage
reused. The optional `dom`
namespace exports constructors such as `dom.Element`, `dom.Text` and
`dom.Document`. Nodes imported from another DOM retain their original prototype.
Fresh Rust-backed nodes have Rusteerio's constructors: an `instanceof` check
against an independently installed `domhandler.Element` requires importing those
nodes or supplying a tree adapter that creates that class.

Each document reports its approximate native size to V8, so the garbage
collector reclaims unreachable documents under native memory pressure. A
document's Rust tree is freed when V8 collects the document, including during
a long synchronous loop: loading 60 documents of 36 MB each in one synchronous
loop grows RSS by about 100 MB after the first 20, where earlier releases held
every tree until the loop ended.

## Benchmarks

### Compared with other Node.js HTML libraries

[![Pages per second on 1 and 16 CPUs for rusteerio, cheerio, parse5 and jsdom.](bench/libraries/overview-v4.svg)](bench/libraries/README.md)

Only parsers that build a WHATWG-compliant tree are compared. htmlparser2 and node-html-parser pass under 1% of the WPT parsing tests, so they are excluded.

The same extraction job ran over 3,000 Common Crawl pages (510 MB): load the page, then read the title, the meta description, every `a[href]`, the h1–h3 text and the image count. On one CPU, rusteerio was **4.5× faster than cheerio**, 1.6× faster than parse5 and 30× faster than jsdom. At 16 CPUs it used **the least working memory of the four** (1.7 GB vs 7.2 GB for cheerio). With `extractAll`, rusteerio stops scaling at about 8 CPUs because its main thread copies every page in and every result out, so at 16 CPUs parse5 was faster. Run as its synchronous API in a `worker_threads` pool, the same setup the other libraries use, rusteerio scaled 4.8× from 1 to 16 CPUs and reached **1,760 pages/s at 16 CPUs**: 1.1× faster than parse5 and 3.0× faster than cheerio, using 3.9 GB of working memory.

| Library | Pages/s, 1 CPU | Pages/s, 16 CPUs | Working memory, 16 CPUs | WPT parsing tests | Feature probes | Packages |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **rusteerio** · extractAll | **415** | **1,390** | **1.7 GB** | **92.7%** | **20/22** | **1** |
| **rusteerio** · worker pool | **364** | **1,760** | **3.9 GB** | **92.7%** | **20/22** | **1** |
| cheerio · worker pool | 92 | 588 | 7.2 GB | 92.5% | 17/22 | 23 |
| jsdom · worker pool | 14 | 73 | 9.8 GB | 92.4% | 14/22 | 36 |
| parse5 · worker pool | 267 | 1,557 | 5.6 GB | 92.5% | 6/22 | 2 |

[![Throughput from 1 to 16 CPUs, log scale.](bench/libraries/scaling-v4.svg)](bench/libraries/README.md#throughput-across-cpu-budgets)

[![Working memory at 16 CPUs and memory per MB of parsed HTML.](bench/libraries/memory-v4.svg)](bench/libraries/README.md#memory)

[![WHATWG tree-construction conformance and feature probes.](bench/libraries/correctness-v4.svg)](bench/libraries/README.md#conformance-and-features)

Each configuration ran on 3 separate boat.dev VMs with 16 vCPUs (AMD Ryzen 9 9950X) and 32 GB of RAM, using Node 24.18.1. Values are the median across the VMs. [Full tables, method, raw results and reproduction](bench/libraries/README.md).

### rusteerio vs Cheerio in detail

These measurements compare **Cheerio 1.2.0** against rusteerio on a Linux x64
**VM with 8 vCPUs and 16 GB RAM** (AMD Ryzen 9 9950X host), running Node
24.18.1. Every benchmark checks that both engines produce the same output.

**Real pages.** 5,000 pages from a public Common Crawl archive each ran a
typical extraction job: load, title and metadata, headings, links, images with
their link ancestry and depth, structured data, a paragraph filter, an element
count, removal of scripts and styles, body text and serialization. Outputs were
identical on all 5,000 pages, and times include loading.

| Measure | Result |
| --- | --- |
| Total time | Cheerio 22.5 s, rusteerio 10.2 s: **2.22× faster** |
| Pages where rusteerio was faster | **4,963 of 5,000**, and the other 37 when rerun |
| Per-page speedup, 10th / 50th / 90th percentile | 1.26× / 1.64× / 2.20× |

The 37 pages that measured slower in the full pass (as low as 0.55×) all measured
1.20× to 2.04× faster when rerun with 25 samples each on the same machine.

**Single operations.** `bench/operations.mjs` times 25 operations on freshly
loaded generated documents of 200 and 2,000 cards. Including each engine's load
time, rusteerio was faster for **50 of 50** HTML measurements in both runs
(median 1.91–2.04×) and **48 of 50** XML measurements (median 1.95–2.05×). HTML
loading alone was 1.77–2.12× faster and XML loading 1.96–2.70× faster.

**Matched CPU budgets.** `bench/fair.mjs` gives both engines the same enforced
CPU budget; batch comparisons give Cheerio a reused Node worker pool and include
each engine's input and result conversion. Values are medians of nine samples.
Rusteerio was faster in **all 45 cases**. Representative results:

| Workload | CPUs | Cheerio | rusteerio | rusteerio |
| --- | ---: | ---: | ---: | --- |
| Load/query, 500 articles | 1 | 35.48 ms | 3.37 ms | 10.54× faster |
| Load/query, 5,000 articles | 1 | 151.35 ms | 36.64 ms | 4.13× faster |
| HTML mutations, 5,000 articles | 1 | 250.75 ms | 67.27 ms | 3.73× faster |
| XML load/query, 5,000 articles | 1 | 74.23 ms | 16.97 ms | 4.37× faster |
| Extract 16 documents × 5,000 articles | 1 | 3,058.97 ms | 473.02 ms | 6.47× faster |
| Extract 16 documents × 5,000 articles | 8 | 788.30 ms | 130.88 ms | 6.02× faster |
| Nested callback extraction, 8 × 500 articles | 8 | 55.11 ms | 33.78 ms | 1.63× faster |
| Cold extraction, 16 × 20 articles | 8 | 21.64 ms | 9.88 ms | 2.19× faster |
| 8 concurrent batches × 8 × 300 articles | 8 | 113.00 ms | 25.55 ms | 4.42× faster |
| HTML stream, 50,000 elements | 1 | 1,259.20 ms | 353.46 ms | 3.56× faster |
| XML stream, 50,000 elements | 8 | 126.08 ms | 69.93 ms | 1.80× faster |
| Append/update/remove, 4,000 cycles | 1 | 733.50 ms | 443.06 ms | 1.66× faster |

Cold measurements include engine import, pool initialization and the first
batch.

**Where Cheerio can be faster.** Rusteerio builds node objects lazily from the
native tree, and an element's `attribs` is a `Proxy` so that assigning or
deleting a key changes the document, as it does in Cheerio. Code that visits
every node and enumerates every element's attributes (`Object.keys(node.attribs)`)
pays for creating those objects and for V8's slower key enumeration on proxies.
Including load, that walk measured 0.54–0.72× in XML, where Cheerio's
htmlparser2 parser leaves less load time to win back, and faster than Cheerio in
HTML. Walking the same nodes without enumerating attributes is faster in both.

**Memory.** A batch extracting 16 documents of 5,000 articles with eight CPUs
ended at 620 MB RSS for rusteerio and 2,449 MB for Cheerio's worker pool, the
HTML stream of 50,000 elements at 364 MB versus 666 MB, and the large XML
load/query at 140 MB versus 149 MB. The XML stream ended slightly higher, at
229 MB versus 222 MB, and the append/update/remove workload about even (93 MB
versus 91 MB). Linux builds use mimalloc, which keeps freed pages briefly for
reuse; after a parse that builds at least 100,000 nodes, the parsing thread
returns them to the system. RSS includes initialization and resident input, and
sampled peaks do not establish a universal memory bound.

These results describe this VM and revision; hardware, runtime and input shape
affect them. See [the results](bench/results/2026-10-14/) and
[the methodology and reproduction steps](bench/README.md).

## Compatibility and tests

The compatibility target is **Cheerio 1.2.0**. All **777 upstream tests across all
14 files** run against rusteerio, including parser and utility tests. Assertions
and fixtures are unchanged; implementation imports are redirected. An integrity
check verifies the complete inventory and source checksums before each run.

The additional **501 runtime and release checks** cover custom parser hooks,
streaming encodings and HTTP, detached-node retention and reuse, cross-document
moves, memory release, extraction callbacks, shared CPU limits and Cheerio's
selection order. **57 Rust tests**, strict TypeScript consumer checks, and clean
npm tarball installation checks run as well. CI builds and tests all eight
native targets
and checks Node 20.19, 22 and 24. GNU binaries are built and run on glibc 2.28;
release checks inspect their actual ELF version requirements.

See [the upstream test suite](test/upstream/README.md) and [the latest validation
record](bench/results/fair/validation.json). Compatibility tests establish
coverage for that version; they do not establish behavior for every possible
input or private extension.

## Development

Use Node.js 20.19+ and stable Rust:

```sh
git clone https://github.com/context-dot-dev/rusteerio.git
cd rusteerio
npm ci
npm run build
npm test
npm run test:upstream
npm run check
npm run test:types
npm run test:package
cargo test
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
```

The Rust engine uses html5ever and scraper for HTML5 parsing and fast queries,
alongside its mutable arena, HTML/XML tokenizer and selector implementation.
Rust dependencies are compiled into the addon and pinned in `Cargo.lock`.
Development dependencies supply build tools and compatibility oracles; package
consumers install no additional npm packages.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local
checks and test conventions, and [RELEASING.md](RELEASING.md) for the npm release
process.

## Credits and license

Created by the **[context.dev team](https://context.dev)**, with thanks to
[Cheerio and its contributors](https://github.com/cheeriojs/cheerio) for the API
and upstream test suite that inspired this project.

Rusteerio's original code is **[MIT licensed](LICENSE)**. Vendored Cheerio tests
retain their [upstream MIT license](test/upstream/LICENSE). Native dependencies
retain their own terms, collected in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
