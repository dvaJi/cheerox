// End-to-end batch extraction, including parsing and result creation.
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { extractAll } from '../dist/index.mjs';

const pages = Array.from({ length: 200 }, (_, page) => '<main>' +
  Array.from({ length: 50 }, (_, item) =>
    `<article><h2>Title ${page}-${item}</h2><a href="/${page}/${item}">Link</a></article>`,
  ).join('') + '</main>');
const map = { titles: ['h2'], links: [{ selector: 'a', value: 'href' }] };
const reference = () => pages.map((page) => cheerio.load(page).extract(map));
const expected = reference();
const cases = [
  ['Cheerio, synchronous', reference],
  ['Cheerox, one native thread', () => extractAll(pages, map, { threads: 1 })],
  ['Cheerox, four native threads', () => extractAll(pages, map, { threads: 4 })],
];

for (const [name, run] of cases) {
  assert.deepEqual(await run(), expected, `${name} produced different results`);
  for (let i = 0; i < 2; i++) await run();
  const samples = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(`${name}: ${samples[3].toFixed(2)} ms (median of 7)`);
}
