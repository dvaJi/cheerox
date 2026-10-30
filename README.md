# cheerox

<p align="center"><strong>Cheerio 0.22.0's API on a Rust engine.</strong></p>

cheerox is a nearly drop-in replacement for legacy **Cheerio 0.22.0**,
powered by a native Rust engine (NAPI-RS). Parsing, DOM storage,
selectors, and mutations run in Rust; TypeScript supplies the familiar API.
Zero npm runtime dependencies.

The vendored Cheerio 0.22.0 test suite runs at the same pass/fail set as the
real package (576/577 — the one failure is upstream dependency drift that the
reference itself reproduces; see [COMPATIBILITY.md](COMPATIBILITY.md)).

## Installation

```sh
npm install @dvaji/cheerox
```

Node.js 20.19+ is recommended. Prebuilt native binaries ship for macOS
arm64/x64, Linux glibc/musl arm64/x64, and Windows arm64/x64 — no Rust
toolchain needed at install time.

## The 0.22.0 API, unchanged

```js
const cheerio = require('@dvaji/cheerox');

const $ = cheerio.load('<div class="item">Hello</div>');
console.log($('.item').text()); // Hello
console.log($.html());          // <div class="item">Hello</div>
```

The module itself is callable, exactly like the original:

```js
const element = cheerio('<div>Hello</div>');
console.log(cheerio.html(element));
```

Legacy selector signatures work:

```js
$('li', '#container');
$('li', '<ul><li>Hello</li></ul>');
$('li', 'ul', '<ul><li>Hello</li></ul>');
```

Direct DOM access matches the original shapes — `node.type`, `node.name`,
`node.attribs` (writable), `node.children`, `node.parent`, `node.prev`,
`node.next`, `node.data`, `node.root`, plus the DOM Lvl 1 aliases
(`tagName`, `childNodes`, `parentNode`, `firstChild`, …).

`$.html()`, `$.xml()`, `$.text()`, `$.parseHTML()`, `$.root()`,
`$.contains()`, `$.version`, `$.fn`, chaining, `end()`, `each`/`map`,
`.attr()/.prop()/.data()/.val()`, classes, `.css()`, form serialization —
all verified by the upstream suite in [`test/legacy/`](test/legacy).

TypeScript and ESM:

```ts
import * as cheerio from '@dvaji/cheerox';
import cheerioDefault from '@dvaji/cheerox';
const $ = cheerio.load('<p>typed</p>');
```

## Modern extras (additive)

The engine's asynchronous, parallel capabilities stay available
from the same package; they keep the legacy parsing defaults:

```ts
import { configureWorkers, loadAsync, loadAll, extractAll, workerPoolInfo } from '@dvaji/cheerox';

configureWorkers({ threads: 4 });
const $ = await loadAsync(largeHtml);
const docs = await loadAll(pages, { threads: 4 });
const rows = await extractAll(pages, { title: 'h1', links: [{ selector: 'a', value: 'href' }] });
console.log(workerPoolInfo());
```

## Performance

Parsing is 1.8–2.3x faster than cheerio 0.22.0; per-node operations over
loaded trees currently trade some speed for the live native DOM (measured,
with verified outputs, in [docs/BENCHMARK.md](docs/BENCHMARK.md) — run
`npm run bench:legacy` to reproduce).

## Compatibility

- [COMPATIBILITY.md](COMPATIBILITY.md) — the full behavioral report,
  known divergences, and node-shape parity notes.
- `npm run test:legacy` — the untouched Cheerio 0.22.0 suite.
- `npm run test:legacy-oracle` — the same suite against the real package.
- `npm run test:differential` — 55 differential operations, machine-readable
  report.

## Development

```sh
git clone https://github.com/dvaJi/cheerox.git
cd cheerox
npm ci
npm run build        # native addon + TypeScript
npm test             # runtime + release checks (modern)
npm run test:legacy  # the 0.22.0 acceptance gate
npm run test:compat  # legacy + 1.2.0 upstream suites
npm run test:native  # cargo test
npm run check        # tsc --noEmit
npm run test:types   # consumer type checks
npm run bench:legacy # cheerox vs cheerio@0.22.0
```

See [COMPATIBILITY.md](COMPATIBILITY.md) for the behavioral report.

## Credits and license

With thanks to [Cheerio](https://github.com/cheeriojs/cheerio) and its
contributors for the API and the test suite that defines this project's
behavior. The vendored Cheerio 0.22.0 tests keep their MIT notice
([test/legacy/reference/LICENSE-MIT](test/legacy/reference/LICENSE-MIT)).
cheerox is MIT licensed ([LICENSE](LICENSE)).
