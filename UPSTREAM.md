# Upstream revisions

This repository is a fork of Rusteerio, retargeted to Cheerio 0.22.0 API and
behavioral compatibility. Both upstream references are pinned:

## Rust foundation — Rusteerio

- Repository: https://github.com/context-dot-dev/rusteerio
- Pinned commit: `af21a24cc14c1fac870405b276ae7514a8c80dfd`
- Tag: `v2.0.0` ("Release 2.0.0", 2026-10-15)
- Vendored on: 2026-10-29
- Relationship: full source vendored (native Rust engine + TypeScript facade).
  The Cheerio 1.2.0 upstream test suite in `test/upstream/` was imported with
  the fork and is used for baseline verification of the shared engine; it is
  NOT the acceptance gate (that is `test/legacy/`).

## Behavioral reference — Cheerio

- Repository: https://github.com/cheeriojs/cheerio
- Pinned commit: `49b477e7fe98b74f61f77acd06a0ef4edb5c333e`
- Tag: `0.22.0`
- Used for: `test/legacy/` test suite source, differential harness oracle
  (installed as the `cheerio-legacy-reference` dev dependency alias), and
  behavioral documentation.
- License: MIT (upstream notices preserved in `test/legacy/`).

## Verifying the pins

```sh
# Rusteerio
git clone https://github.com/context-dot-dev/rusteerio
git -C rusteerio rev-parse v2.0.0   # af21a24cc14c1fac870405b276ae7514a8c80dfd

# Cheerio
git clone https://github.com/cheeriojs/cheerio
git -C cheerio rev-parse 0.22.0     # 49b477e7fe98b74f61f77acd06a0ef4edb5c333e
```

`test/legacy/checksums.json` records SHA-256 checksums of the original
Cheerio 0.22.0 test files; `scripts/check-legacy.mjs` verifies them before the
suite runs.
