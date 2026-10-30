import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const directory = new URL('../test/upstream/', import.meta.url);
const fixture = '__fixtures__/fixtures.ts';
const manifest = JSON.parse(readFileSync(new URL('full-suite-validation.json', directory), 'utf8'));
if (!Array.isArray(manifest.files) || manifest.files.length !== 15) {
  throw new Error('Upstream integrity manifest must contain 14 spec files and the fixture.');
}

const expected = new Map();
for (const entry of manifest.files) {
  const path = typeof entry.path === 'string' ? entry.path.replace(/^test\/upstream\//, '') : '';
  if (!path || !path.split('/').every((part) => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..')) {
    throw new Error(`Invalid upstream manifest path: ${entry.path}`);
  }
  if (expected.has(path)) throw new Error(`Duplicate upstream manifest path: ${path}`);
  if (path !== fixture && !path.endsWith('.spec.ts')) throw new Error(`Unexpected upstream manifest file: ${path}`);
  if (entry.importOnlyDifferences !== true || !/^[a-f\d]{64}$/.test(entry.upstreamSha256 ?? '') || !/^[a-f\d]{64}$/.test(entry.vendoredSha256 ?? '')) {
    throw new Error(`Invalid upstream integrity metadata: ${path}`);
  }
  expected.set(path, entry.vendoredSha256);
}
if (!expected.has(fixture) || [...expected.keys()].filter((path) => path.endsWith('.spec.ts')).length !== 14) {
  throw new Error('Upstream integrity manifest must contain exactly 14 specs and __fixtures__/fixtures.ts.');
}

function specs(url = directory, prefix = '') {
  return readdirSync(url, { withFileTypes: true }).flatMap((entry) => {
    const path = `${prefix}${entry.name}`;
    return entry.isDirectory() ? specs(new URL(`${entry.name}/`, url), `${path}/`) : path.endsWith('.spec.ts') ? [path] : [];
  });
}
const actual = specs();
const missing = [...expected.keys()].filter((path) => path !== fixture && !actual.includes(path));
const extra = actual.filter((path) => !expected.has(path));
if (missing.length || extra.length || actual.length !== 14) {
  throw new Error(`Upstream spec inventory changed. Missing: ${missing.join(', ') || '(none)'}. Extra: ${extra.join(', ') || '(none)'}.`);
}
for (const [path, expectedHash] of expected) {
  // Git can check out CRLF on Windows. Hash UTF-8 text with CRLF normalized to
  // LF, matching the source bytes fetched from the upstream tag.
  const contents = readFileSync(new URL(path, directory), 'utf8').replace(/\r\n/g, '\n');
  const actualHash = createHash('sha256').update(contents).digest('hex');
  if (actualHash !== expectedHash) throw new Error(`Upstream vendored file changed: ${path}`);
}
console.log('Upstream integrity passed: 14 specs and fixture match the Cheerio 1.2.0 manifest (CRLF normalized to LF).');
