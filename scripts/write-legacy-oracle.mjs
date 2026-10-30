/**
 * Materializes test/legacy-oracle/ from the pristine upstream copies in
 * test/legacy/reference/: the identical Cheerio 0.22.0 suite, with imports
 * pointing at the real cheerio@0.22.0 package (the `cheerio-legacy-reference`
 * dev dependency alias) instead of this library.
 *
 * Running both suites gives an honest baseline: tests that fail in the oracle
 * are upstream dependency drift, not implementation gaps.
 *
 * Run: node scripts/write-legacy-oracle.mjs
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const reference = join(here, '..', 'test', 'legacy', 'reference');
const oracle = join(here, '..', 'test', 'legacy-oracle');

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

// The reference package ships its internal lib/, so the parse module tests
// can exercise the real lib/parse.js.
const rewrites = [
  [/require\('\.\.\/'\)/g, "require('cheerio-legacy-reference')"],
  [/require\('\.\.\/\.\.'\)/g, "require('cheerio-legacy-reference')"],
  [/require\('\.\.'\)/g, "require('cheerio-legacy-reference')"],
  [/require\('\.\.\/lib\/parse'\)/g, "require('cheerio-legacy-reference/lib/parse')"],
];

rmSync(oracle, { recursive: true, force: true });
mkdirSync(join(oracle, 'api'), { recursive: true });
for (const file of files) {
  const original = readFileSync(join(reference, file), 'utf8');
  let adapted = original;
  for (const [pattern, replacement] of rewrites) adapted = adapted.replace(pattern, replacement);
  writeFileSync(join(oracle, file), adapted);
}
console.log(`Oracle suite materialized in test/legacy-oracle (${files.length} files).`);
