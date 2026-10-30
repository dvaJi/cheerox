# Compatibility report — cheerox vs Cheerio 0.22.0

Status: **2026-10-30** — the untouched Cheerio 0.22.0 test suite runs against
cheerox with the same pass/fail set as the real `cheerio@0.22.0` package.

## Test inventories

| Suite | Command | Result |
| --- | --- | --- |
| Cheerio 0.22.0 suite (vendored, untouched) | `npm run test:legacy` | **576 pass / 1 fail / 1 pending** |
| Same suite against the real cheerio@0.22.0 | `npm run test:legacy-oracle` | **576 pass / 1 fail / 1 pending** |
| Differential harness (55 operations, real-world pages) | `npm run test:differential` | **55 pass / 0 fail** |
| Cheerox 1.2.0 modern runtime checks | `npm test` | **514 pass / 0 fail** |
| Cheerio 1.2.0 upstream suite (modern mode) | `npm run test:upstream` | **777 pass / 0 fail** |
| Rust engine tests | `npm run test:native` (`cargo test`) | **57 pass / 0 fail** |

The legacy gate matches the oracle exactly. The single failing test fails for
the same reason in both runs (below).

## Known divergences

### 1. Upstream dependency drift: empty attributes in HTML serialization
`cheerio .load → should render xml in html() when options.xmlMode = true
passed to html()` — `dom.html({ xmlMode: true })` after a non-xmlMode load.

- Test expectation (2016): `<mixedcasetag uppercaseattribute=""></mixedcasetag>`
- cheerio@0.22.0 as installable today: `<mixedcasetag uppercaseattribute></mixedcasetag>`
- cheerox: `<mixedcasetag uppercaseattribute></mixedcasetag>` (**matches the oracle**)

Cause: cheerio 0.22.0 declares `"dom-serializer": "~0.1.0"`; the resolution
today (0.1.1) renders empty-string attributes bare in HTML mode, while the
2016-era resolution emitted `=""`. cheerox ports dom-serializer 0.1.1's
behavior, which is what the reference package produces when installed today.
The test fails identically in `npm run test:legacy-oracle`.

### 2. Intentional shape difference: `root` references
0.22.0 stores `node.root` as a plain JavaScript field (the document root for
top-level nodes, `null` after moves). cheerox keeps it in a side table keyed
by the node view; reads and writes behave like the original field. The
synthetic root also keeps `name: 'root'` and an `attribs` object, as in
0.22.0.

### 3. Internal protocol names
Internal registry keys (`Symbol.for('cheerox.*')`) and the
`CHEEROX_THREADS` environment variable are implementation details of the
native engine. They are invisible through the public API.

## Node shape parity

With the defaults (`withDomLvl1: true`), legacy node objects expose the
0.22.0 contract:

- Own enumerable fields, as on the original plain objects:
  `type`, `name`, `attribs`, `children`, `parent`, `prev`, `next`
  (`data` on text/comment/directive). `Object.keys(node)` matches.
- DOM Lvl 1 aliases from domhandler 2.4.2: `tagName`, `childNodes`,
  `parentNode`, `previousSibling`, `nextSibling`, `nodeValue`, `firstChild`,
  `lastChild`, `nodeType`.
- A top-level node's `parent` is `null`; its document root is reachable via
  `node.root` (0.22.0 model, including the quirks: nodes moved out keep
  stale `root` references until the library updates them).
- `attribs` is a live proxy: direct writes (`node.attribs.id = 'x'`) mutate
  the document, as in 0.22.0.
- `el.data` on elements is a plain JavaScript object used by `.data()`.

Storage stays in the Rust arena; the fields are live views, so legacy
consumers that mutate nodes directly (domhandler-era code) work.

## Parsing parity

Default parsing is htmlparser2-style fragment parsing in the Rust engine
(`_useHtmlParser2: true`, `isDocument: false`) with the 0.22.0 defaults:

```
{ withDomLvl1: true, normalizeWhitespace: false, xmlMode: false, decodeEntities: true }
```

Verified by the parse.js suite (tag/attribute lowercasing, implicit closing,
self-closing, comments, directives, script/style raw text, CDATA in xmlMode),
xml.js (case preservation, CDATA, serialization), and the cheerio.js load
tests. `normalizeWhitespace` collapses text-node whitespace after parsing as
htmlparser2 3.9.1 did (script/style contents stay raw).

## Serialization parity

`$.html()`, `$.xml()`, `.html()`, `.toString()` render through a faithful
port of dom-serializer 0.1.x + entities 1.1 over the native tree, including:

- the five XML characters plus every non-ASCII rune encoded as `&#x…;` when
  `decodeEntities` is on (0.22.0's observable behavior),
- raw text in `script`/`style`/`xmp`/`iframe`/`noembed`/`noframes`/
  `plaintext`/`noscript`,
- bare `key` for empty attributes in HTML mode, `key=""` in XML mode,
- the 0.1.x void-element list, `<!doctype …>` directives, CDATA, and the
  SVG-is-XML special case.

## Selection parity

`find`, `filter`, `not`, `is`, `has`, `closest`, `parent(s[Until])`,
`next(All|Until)`, `prev(All|Until)`, `siblings`, `children`, `contents`
reproduce css-select 1.2.0's scoped semantics: candidates are the elements of
the base set and their descendants, a candidate must satisfy the selector and
be the context node or a descendant of one, and a context node can match
itself (the absolutized `:scope` descendant rule with its `acceptSelf`
branch). Leading `>`/`+`/`~` combinators anchor at the context. Invalid
selectors throw `SyntaxError`, and pseudo-classes that only exist in later
Cheerio lines (`:eq`, `:lt`, `:gt`, `:first`, `:last`, `:even`, `:odd`,
`:is`) are rejected with the original `unmatched pseudo-class` error — the
native engine supports them, but 0.22.0 did not, and parity wins.

## Modules and entry points

```js
const cheerio = require('cheerox');      // callable, as in 0.22.0
const $ = cheerio.load('<div/>');
cheerio('<div>');                        // bare construction
cheerio.html(element);                   // statics on the module
$('li', '#container');                   // legacy selector signatures
$('li', '<ul><li>');
$('li', 'ul', '<ul><li>');
$.version; $.fn; $.root(); $.contains(); $.parseHTML();
import * as cheerio from 'cheerox';      // ESM: named exports + callable default
import cheerio from 'cheerox';
import { loadAsync, extractAll } from 'cheerox';  // modern extras (additive)
import * as modern from 'cheerox/modern';         // full 1.2.0-style facade
```

The modern extras (`loadAsync`, `loadAll`, `extractAll`,
`configureWorkers`, `workerPoolInfo`, streams/URL loading) are re-exported
additively from the root; batch parsing uses the legacy defaults.

## Not ported (do not exist in 0.22.0)

`$.merge`, `$.fn.extend` plugin surface beyond `$.fn` itself, `$.proto` —
these appear in later Cheerio lines. The modern entry (`cheerox/modern`)
provides the 1.2.0 APIs, including `merge`.
