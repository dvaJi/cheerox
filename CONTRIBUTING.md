# Contributing to rusteerio

Thanks for helping improve rusteerio. The project is maintained by the
[context.dev team](https://context.dev) and is heavily inspired by
[Cheerio](https://github.com/cheeriojs/cheerio).

## Local setup

Use Node.js 20.19 or newer and stable Rust. Clone the repository, then run:

```sh
npm ci
npm run build
```

The native addon is built for your current platform. Consumers of published
releases use bundled binaries and do not need this build toolchain.

## Checks

```sh
npm run check
npm test
npm run test:upstream
npm run test:types
npm run test:package
cargo test
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
```

Changes to package contents or release scripts also need
`npm run release:check -- --local`. After changing native dependencies, review
their licenses, run `npm run notices:generate`, and commit the resulting notices
and any required pinned source records. `npm run notices:check` verifies that
the notices match the locked dependency graph.

CI pins the Rust compilers used for release binaries. Compiler upgrades also
require reviewing the standard-library notices in `scripts/notices/runtime.json`
and regenerating `THIRD_PARTY_NOTICES.md`.

## Compatibility tests

Cheerio 1.2.0 defines the compatibility target. All 14 upstream test files live
in `test/upstream`, with their original assertions and fixtures. The test runner
checks their inventory and hashes before executing the 777 tests.

Fix failures in the implementation. Keep the upstream assertions intact and
put new project regression tests in `test/*.test.mjs` or the Rust test modules.
Changes to the upstream suite require an explicit upstream version update,
documented import redirections, and an updated integrity manifest after
comparison with the original sources.

## Pull requests

Describe the input or operation that exposes the problem, the resulting
behavior, and the checks you ran. Keep changes focused. Include a small
reproduction or regression test when changing parsing, selection, DOM mutation,
node identity, encoding or async behavior.

For performance work, compare equal outputs against Cheerio, include warm-up
and multiple timed samples, and record the Node version, platform, CPU count,
worker count and garbage-collection policy. Use a VM for substantial load runs.
The benchmark scripts and methodology are in [bench/README.md](bench/README.md).

## Reporting issues

Use the repository's issue templates. Include the rusteerio version, Node
version, OS/architecture, parser options, and the smallest HTML/XML and code
sample that demonstrates the behavior. For compatibility reports, include
Cheerio 1.2.0's output as well.

Contributions are licensed under the project's [MIT license](LICENSE).
