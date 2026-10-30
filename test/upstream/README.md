This is the complete test suite and fixtures from Cheerio v1.2.0 (commit
e3c7aaf9ed64fe3cb9a181e58a41c0fdd6dbfbfc),
https://github.com/cheeriojs/cheerio/tree/v1.2.0/src, under its MIT license
(included here as LICENSE). Imports of the library under test point to shim.ts;
test assertions and fixtures are unmodified. All 14 upstream test files are
included, including parser and utility tests: 777 tests, with no added skips.
Parser imports point to the production Rust adapters used by `Cheerio._parse`;
utility imports point to the built package's utility entry point. No reference
JavaScript parser runs as the implementation under test.

The [full-suite validation record](full-suite-validation.json) includes each
upstream file's original and vendored checksums and execution counts.

Run `npm run build && npm run test:upstream`.
