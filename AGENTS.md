# Agent Guidelines for cheerox

Rust/NAPI rewrite of cheerio's engines with a 0.22-compatible legacy facade
and a 1.2-compatible modern facade. Compatibility is the gate: every change
must pass the full battery below.

## Non-negotiable before committing Rust changes

The "Publish to npm" workflow runs these and fails the whole release if any
reports a problem. They have bitten more than once — run them locally
**before** pushing, in this order:

```bash
cargo fmt --all                                              # FIX, don't just check
cargo clippy --all-targets -- -D warnings
cargo test
```

`cargo fmt --all -- --check` after editing is how a publish run dies six
minutes in. Always run the fixing form first, then the check if you want
confirmation.

## Version bump discipline

Releases bump four files in lockstep: `package.json`,
`package-lock.json` (both `version` fields), `Cargo.toml`, and `Cargo.lock`
(**only** the `name = "cheerox"` entry). Never run a bare `cargo update`
while bumping — it drags unrelated dependencies to unverifiable checksums
(this happened with `web_atoms`) and breaks `cargo metadata --locked`,
which the notices flow depends on.

After any lockfile change:

```bash
npm run notices:generate
npm run notices:check   # must exit 0
```

## Release flow

1. Full battery green (see below), on a clean rebuilt `dist/`.
2. Bump versions, regenerate notices, `npm run build`.
3. Commit to master, push, tag `v0.1.x` — **the tag must point at the exact
   master release commit**. If a publish run fails and you fix-forward,
   delete and re-push the tag onto the fix commit.
4. `gh workflow run publish.yml --ref master -f version=<v> -f npm_tag=latest`
   (OIDC trusted publisher; do not publish from a local shell).
5. npm CDN lag is real: packument metadata updates first, the tarball URL
   404s for roughly 5-10 minutes. Probe with cache-busting HEAD requests;
   a 404 right after publish is propagation, not a broken release.

## The battery (all green = releasable)

| Command | Covers |
| --- | --- |
| `npm test` | JS suite (534) |
| `npm run test:legacy` | 0.22 facade suite (577) |
| `npm run test:upstream` | cheerio 1.2.0's own suite (777, modern facade) |
| `npm run test:differential` | semantic diff vs real cheerio@0.22.0 (56/58 + 2 documented divergences) |
| `node --expose-gc bench/gate.mjs` | performance gate |
| `npm run test:types` | consumer-facing type surface |
| `npm run test:package` + `npm run release:check -- --local` | tarball contents, zero deps, native targets |

The two differential divergences are **documented parse5 alignment**
(`scripts/differential.mjs` → `acceptedDivergences`): the legacy facade
wraps bare `<tr>` in `<tbody>` like the engines consumers migrate from,
which the htmlparser2 oracle does not. Do not "fix" them and do not add
new ones without a written justification there.

## Types must match the runtime

If you declare something on `CheerioInstance`/`CheerioStatic` in
`src/cheerio-compat/types.ts`, verify it actually exists at runtime with a
probe against `dist/` before releasing. Symbol.iterator was declared in
0.1.4 without an implementation and for..of threw for two releases until a
consumer hit it. Ten-line probe scripts are cheap; a broken drop-in
promise is not.

## Known deliberate divergences from cheerio 1.x

- Serializer escapes non-ASCII and quotes (`｜` → `&#xFF5C;`,
  `"` → `&quot;`) per the 0.22-era serializer. Semantically identical
  HTML; anything that parses the markup (turndown, browsers) decodes it
  back. Numeric entities are NOT decoded by naive `&quot;`-style replaces
  in consumer code.
- `<noscript>` children parse as elements (html5ever path) — equivalent
  render output, different DOM shape.
