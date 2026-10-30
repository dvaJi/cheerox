/**
 * Verifies the Cheerio 0.22.0 legacy test suite integrity:
 *  1. every pristine upstream copy in test/legacy/reference/ matches its
 *     recorded SHA-256 checksum, and
 *  2. every adapted test file differs from its pristine copy ONLY in the
 *     documented import-path rewrites.
 *
 * Run: node scripts/check-legacy.mjs [--update]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const legacy = join(here, '..', 'test', 'legacy');

const files = [
  'cheerio.js',
  'parse.js',
  'xml.js',
  'fixtures.js',
  'api/attributes.js',
  'api/css.js',
  'api/forms.js',
  'api/manipulation.js',
  'api/traversing.js',
  'api/utils.js',
];

/** The only allowed difference: where the suite resolves modules from. */
const rewrites = [
  // The package root: 0.22.0 tests sit one directory deeper in this repo.
  [/require\('\.\.\/'\)/g, "require('../../')"],
  [/require\('\.\.\/\.\.'\)/g, "require('../../../')"],
  [/require\('\.\.'\)/g, "require('../../')"],
  // Our legacy parse module is exposed from the built package.
  [/require\('\.\.\/lib\/parse'\)/g, "require('../../dist/legacy-parse.cjs')"],
];

const update = process.argv.includes('--update');
const manifestPath = join(legacy, 'checksums.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

assert.equal(manifest.upstream.commit, '49b477e7fe98b74f61f77acd06a0ef4edb5c333e');
assert.equal(manifest.upstream.tag, '0.22.0');

let failures = 0;
for (const file of files) {
  const original = readFileSync(join(legacy, 'reference', file), 'utf8');
  const checksum = createHash('sha256').update(original, 'utf8').digest('hex');
  const recorded = manifest.files[file];
  if (recorded === undefined) {
    if (update) manifest.files[file] = checksum;
    else { console.error(`checksums.json is missing ${file}`); failures++; }
  } else if (recorded !== checksum) {
    console.error(`checksum mismatch for ${file}: upstream copy changed`);
    failures++;
  }
  let adapted;
  try {
    adapted = readFileSync(join(legacy, file), 'utf8');
  } catch {
    continue;
  }
  let expected = original;
  for (const [pattern, replacement] of rewrites) expected = expected.replace(pattern, replacement);
  if (expected !== adapted) {
    console.error(`adapted ${file} differs from its original beyond documented import rewrites`);
    failures++;
  }
}

if (update) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`checksums.json updated (${files.length} files)`);
} else if (failures) {
  process.exit(1);
} else {
  console.log(`Legacy suite integrity passed: ${files.length} specs match the Cheerio 0.22.0 checksums, and adaptations are import-path rewrites only.`);
}
