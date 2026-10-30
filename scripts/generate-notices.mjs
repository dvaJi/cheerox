#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'THIRD_PARTY_NOTICES.md');
const cacheDir = join(root, 'scripts', 'notices');
const check = process.argv.includes('--check');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--check')) throw new Error('Usage: node scripts/generate-notices.mjs [--check]');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const read = (path) => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const legalName = /^(?:licen[cs]e(?:[-_.].*)?|unlicense|copying(?:[-_.].*)?|copyright(?:[-_.].*)?|notice(?:[-_.].*)?|authors(?:[-_.].*)?)$/i;
const metadata = JSON.parse(execFileSync(process.env.CARGO || 'cargo', [
  'metadata', '--locked', '--format-version', '1',
], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
const vendored = new Set(['html5ever@0.35.0', 'markup5ever@0.35.0', 'html5gum@0.8.4']);
for (const pkg of metadata.packages) {
  if (!pkg.source && pkg.name !== 'cheerox' && !vendored.has(`${pkg.name}@${pkg.version}`)) throw new Error(`Review notices for the new local dependency ${pkg.name}@${pkg.version}`);
}
const packages = metadata.packages.filter((pkg) => pkg.source || vendored.has(`${pkg.name}@${pkg.version}`))
  .sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version));
const byName = new Map(packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]));
const supplements = JSON.parse(read(join(cacheDir, 'sources.json')));
if (supplements.schemaVersion !== 1) throw new Error('Unsupported supplemental notice schema');
const runtime = JSON.parse(read(join(cacheDir, 'runtime.json')));
if (runtime.schemaVersion !== 1) throw new Error('Unsupported Rust runtime notice schema');
if (check) {
  const rustc = execFileSync(process.env.RUSTC || 'rustc', ['--version'], { encoding: 'utf8' }).trim();
  const version = /^rustc (\d+\.\d+\.\d+)/.exec(rustc)?.[1];
  if (!version || !runtime.releases[version]) throw new Error(`Review and add standard-library notices before releasing with ${rustc}`);
}

for (const [file, entry] of Object.entries(supplements.cache)) {
  if (sha256(read(join(cacheDir, file))) !== entry.sha256) throw new Error(`Supplemental notice checksum mismatch: ${file}`);
}
for (const key of Object.keys(supplements.packages)) {
  if (!byName.has(key)) throw new Error(`Remove or review stale supplemental notices for ${key}`);
}

function legalFiles(dir, base = dir, insideLegalDir = false) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'target') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...legalFiles(path, base, insideLegalDir || /^(?:licen[cs]es?|notices?)$/i.test(entry.name)));
    else if (entry.isFile() && (insideLegalDir || legalName.test(entry.name))) files.push(relative(base, path).replaceAll('\\', '/'));
  }
  return files.sort(compare);
}

function crateSource(pkg, path) {
  return `https://docs.rs/crate/${pkg.name}/${pkg.version}/source/${path}`;
}

const texts = new Map();
function notice(name, source, text) {
  if (!text.trim()) throw new Error(`Empty notice: ${name}`);
  const digest = sha256(text);
  if (!texts.has(digest)) texts.set(digest, text);
  return { name, source, digest };
}

function cachedNotice(entry) {
  if (!supplements.cache[entry.cache]?.sources.includes(entry.source)) throw new Error(`Unknown notice provenance for ${entry.cache}`);
  return notice(entry.name, entry.source, read(join(cacheDir, entry.cache)));
}

function packageNotices(pkg) {
  const dir = dirname(pkg.manifest_path);
  const files = legalFiles(dir);
  if (pkg.license_file) {
    const path = relative(dir, resolve(dir, pkg.license_file)).replaceAll('\\', '/');
    if (!files.includes(path)) files.push(path);
  }
  const notices = files.sort(compare).map((file) => notice(file, crateSource(pkg, file), read(join(dir, file))));
  const extra = supplements.packages[`${pkg.name}@${pkg.version}`];
  for (const entry of extra?.notices || []) {
    if (entry.cache) {
      notices.push(cachedNotice(entry));
    } else {
      const sourcePackage = entry.package ? byName.get(entry.package) : pkg;
      if (!sourcePackage) throw new Error(`Missing supplemental source package ${entry.package}`);
      let text = read(join(dirname(sourcePackage.manifest_path), entry.file));
      if (entry.startLine) text = text.split('\n').slice(entry.startLine - 1, entry.endLine).join('\n') + '\n';
      notices.push(notice(entry.name, crateSource(sourcePackage, entry.file), text));
    }
  }
  if (!pkg.license) throw new Error(`Review missing license expression for ${pkg.name}@${pkg.version}`);
  if (!notices.length) throw new Error(`No license notices found for ${pkg.name}@${pkg.version}; add a reviewed supplemental source`);
  return { notices, reason: extra?.reason };
}

const upstreamLicense = notice('Cheerio MIT LICENSE',
  'https://github.com/cheeriojs/cheerio/blob/e3c7aaf9ed64fe3cb9a181e58a41c0fdd6dbfbfc/LICENSE',
  read(join(cacheDir, 'cheerio-MIT.txt')));
const htmlparser2License = cachedNotice({
  cache: 'htmlparser2-MIT.txt',
  name: 'htmlparser2 MIT LICENSE',
  source: 'https://raw.githubusercontent.com/fb55/htmlparser2/57ace50bf6eb3bfab0468deafe10d0a8a2f233aa/LICENSE',
});
const vendoredCheerioLicense = join(root, 'test', 'upstream', 'LICENSE');
if (existsSync(vendoredCheerioLicense) && read(vendoredCheerioLicense) !== read(join(cacheDir, 'cheerio-MIT.txt'))) {
  throw new Error('Vendored Cheerio license differs from the pinned upstream notice');
}
const records = packages.map((pkg) => ({ pkg, ...packageNotices(pkg) }));
const runtimeReleases = Object.entries(runtime.releases).sort(([a], [b]) => compare(a, b))
  .map(([version, entry]) => ({ version, ...entry, notices: entry.notices.map(cachedNotice) }));
const runtimePackages = Object.entries(runtime.packages).sort(([a], [b]) => compare(a, b))
  .map(([key, entry]) => ({ key, ...entry, notices: entry.notices.map(cachedNotice) }));
const parts = [
  '# Third-party notices',
  '',
  'This file preserves third-party license and attribution notices for the Rust native addon and the upstream Cheerio compatibility tests. cheerox itself is distributed under its MIT LICENSE. Third-party components retain their own licenses.',
  '',
  'Generated by `node scripts/generate-notices.mjs` from `cargo metadata --locked`, crate license files, and the pinned supplemental sources recorded in `scripts/notices/sources.json`. It includes build dependencies and dependencies for all target platforms; a particular binary may use a subset. Identical notice texts are reproduced once and referenced below. The html5ever, markup5ever and html5gum crates contain local observer-hook and opt-in UTF-16 transport patches; their complete patched source and original notices are included in `native/vendor`. Other dependency source files are unmodified.',
  '',
  `Cargo.lock SHA-256: \`${sha256(readFileSync(join(root, 'Cargo.lock')))}\`.`,
  '',
  '## Source availability',
  '',
  'The native addon includes code from packages licensed under MPL-2.0. The complete, unmodified Source Code Form of each dependency is available without charge from the version-specific source download links below. These downloads contain the corresponding upstream source and notices. MPL-covered source remains available under MPL-2.0, whose full text is included in this file. The MIT license for cheerox does not restrict rights granted by third-party source licenses.',
  '',
  'The locally patched html5ever and markup5ever components are licensed under MIT OR Apache-2.0; html5gum is licensed under MIT. Their upstream archives are linked below; the exact patched Source Code Form is shipped in the npm package under `native/vendor` and maintained in [this repository](https://github.com/dvaJi/cheerox/tree/main/native/vendor). See `native/vendor/README.md` for the patch scope. Their original license and copyright files remain intact.',
  '',
  '## Cheerio compatibility tests',
  '',
  'The vendored compatibility suite and fixtures come from Cheerio 1.2.0, commit `e3c7aaf9ed64fe3cb9a181e58a41c0fdd6dbfbfc`. Implementation imports are redirected to cheerox. Their original MIT notice is retained in `test/upstream/LICENSE` and reproduced here.',
  '',
  `- [${upstreamLicense.name}](#notice-${upstreamLicense.digest.slice(0, 16)}) — [upstream source](${upstreamLicense.source})`,
  '',
  '## htmlparser2 tokenizer port',
  '',
  'The htmlparser2-compatible markup tokenizer in `native/src/markup_tokenizer.rs` ports the state machine of htmlparser2 10.1.0, commit `57ace50bf6eb3bfab0468deafe10d0a8a2f233aa`. Its original MIT notice is reproduced here.',
  '',
  `- [${htmlparser2License.name}](#notice-${htmlparser2License.digest.slice(0, 16)}) — [upstream source](https://github.com/fb55/htmlparser2/blob/57ace50bf6eb3bfab0468deafe10d0a8a2f233aa/LICENSE)`,
  '',
  `## Rust dependencies (${records.length} locked packages)`,
];
for (const { pkg, notices, reason } of records) {
  parts.push('', `### ${pkg.name} ${pkg.version}`, '', `Declared license: \`${pkg.license}\`.`, '',
    `Source: [${pkg.name} ${pkg.version} source archive](https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download).`);
  if (reason) parts.push('', reason);
  if (!pkg.source) {
    const sourcePath = relative(root, dirname(pkg.manifest_path)).replaceAll('\\', '/');
    if (sourcePath !== `native/vendor/${pkg.name}-${pkg.version}`) throw new Error(`Unexpected vendored dependency path: ${sourcePath}`);
    parts.push('', `Locally patched source: \`${sourcePath}\` (included in the npm package). Original upstream licenses are retained.`);
  }
  parts.push('');
  for (const entry of notices) parts.push(`- [${entry.name}](#notice-${entry.digest.slice(0, 16)}) — [notice source](${entry.source})`);
}
parts.push('', '## Rust standard-library runtime', '',
  `The native addon builds used Rust ${runtimeReleases.map((entry) => entry.version).join(' and ')}. These curated notices preserve their standard-library copyright declarations, in-tree exceptions, compiler-builtins license, and the union of packages in their standard-library lockfiles. The lockfiles include dependencies for other targets and tests; a shipped binary uses a subset. New compiler releases require reviewing and refreshing this runtime notice snapshot.`, '',
  'The runtime snapshots in `scripts/notices/runtime.json` and their exact cached notice texts are independent of the local compiler used to regenerate this document. They contain no copied HTML documentation.');
for (const entry of runtimeReleases) {
  parts.push('', `### Rust ${entry.version}`, '', `[Standard-library source](${entry.source}); [upstream lockfile](${entry.lockSource}); [upstream copyright metadata](${entry.annotationsSource}).`, '',
    `Upstream standard-library Cargo.lock SHA-256: \`${entry.lockSha256}\`.`, '');
  for (const text of entry.notices) parts.push(`- [${text.name}](#notice-${text.digest.slice(0, 16)}) — [notice source](${text.source})`);
  parts.push('', 'In-tree attributions from the upstream copyright metadata:', '');
  for (const item of entry.inTreeAttributions) {
    parts.push(`- \`${item.path}\` — \`${item.spdx}\`; ${item.copyright.join('; ')}.`);
  }
  parts.push('', `Standard-library locked packages: ${entry.packages.map((key) => `\`${key}\``).join(', ')}.`);
}
parts.push('', '### Standard-library dependency notices');
for (const entry of runtimePackages) {
  parts.push('', `#### ${entry.name} ${entry.version}`, '', `Declared license: \`${entry.license}\`. [Unmodified source archive](${entry.source}).`, '',
    `Source archive SHA-256 from the upstream lockfile: \`${entry.checksum}\`.`, '');
  for (const text of entry.notices) parts.push(`- [${text.name}](#notice-${text.digest.slice(0, 16)}) — [notice source](${text.source})`);
}
parts.push('', '## Full license and attribution texts');
for (const [digest, text] of [...texts].sort(([a], [b]) => compare(a, b))) {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  parts.push('', `<a id="notice-${digest.slice(0, 16)}"></a>`, '', `### Notice ${digest.slice(0, 16)}`, '', `${fence}text`, text.replace(/\n$/, ''), fence);
}
const generated = parts.join('\n') + '\n';
if (check) {
  if (!existsSync(output) || read(output) !== generated) throw new Error('THIRD_PARTY_NOTICES.md is stale. Run npm run notices:generate and commit the updated file.');
  console.log(`Third-party notices match ${records.length} locked Rust packages and Cheerio 1.2.0.`);
} else {
  writeFileSync(output, generated);
  console.log(`Generated THIRD_PARTY_NOTICES.md for ${records.length} locked Rust packages and Cheerio 1.2.0.`);
}
