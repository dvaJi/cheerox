/**
 * Legacy benchmark: cheerox's 0.22.0 facade vs the real cheerio@0.22.0.
 *
 * Every case verifies that both engines produce equivalent output before
 * timing, then reports median ops/s of measured runs. Synchronous workloads
 * only: the 0.22.0 API is synchronous by contract.
 *
 * Run: npm run bench:legacy
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const legacy = require(join(here, '..', 'dist', 'index.cjs'));
const oracle = require('cheerio-legacy-reference');

function generateDocument(articles) {
  const parts = ['<div class="page"><header><h1>Generated page</h1></header>'];
  for (let index = 0; index < articles; index++) {
    parts.push(
      `<article class="card" id="card-${index}"><h2>Article ${index}</h2>` +
      `<p class="teaser">Teaser &amp; summary for article ${index}.</p>` +
      `<a href="/a/${index}">Read more</a><img src="/img/${index}.png" alt="Image ${index}">` +
      `<ul><li>Tag ${index % 7}</li><li>Tag ${(index + 1) % 7}</li></ul></article>`,
    );
  }
  parts.push('</div>');
  return parts.join('');
}

const fixtures = {
  small: generateDocument(20),
  large: generateDocument(2000),
  realWorld: '<!DOCTYPE html><html lang=en><meta charset=utf-8><title>Shop</title><nav><ul><li><a href="/">Home</a><li><a href=/catalog>Catalog</ul></nav><main>' + generateDocument(120) + '</main><footer>&copy; 2026</footer>',
};

const cases = [
  {
    name: 'parse only (small)',
    input: fixtures.small,
    setup: () => ({}),
    run: (mod, html) => mod.load(html),
    verify: (a, b) => a('<h1>').text() === b('<h1>').text() && a.html() === b.html(),
    extract: ($) => $.html().length,
  },
  {
    name: 'parse only (large)',
    input: fixtures.large,
    setup: () => ({}),
    run: (mod, html) => mod.load(html),
    verify: (a, b) => a.html() === b.html(),
    extract: ($) => $.html().length,
  },
  {
    name: 'parse + queries (large)',
    input: fixtures.large,
    setup: () => ({}),
    run: (mod, html) => {
      const $ = mod.load(html);
      return {
        titles: $('article h2').length,
        hrefs: $('a[href]').toArray().map((node) => node.attribs.href).join(','),
        text: $('.page').text().length,
        tagged: $('article').filter('.card').length,
      };
    },
    verify: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    extract: (result) => result.titles,
  },
  {
    name: 'attribute extraction (real-world)',
    input: fixtures.realWorld,
    setup: () => ({}),
    run: (mod, html) => {
      const $ = mod.load(html);
      return $('a').toArray().map((node) => ({ href: node.attribs.href, text: $(node).text() }));
    },
    verify: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    extract: (result) => result.length,
  },
  {
    name: 'text extraction (large)',
    input: fixtures.large,
    setup: () => ({}),
    run: (mod, html) => mod.load(html)('article p').text(),
    verify: (a, b) => a === b,
    extract: (result) => result.length,
  },
  {
    name: 'mutations (small)',
    input: fixtures.small,
    setup: () => ({}),
    run: (mod, html) => {
      const $ = mod.load(html);
      $('article').each(function (index) {
        $(this).attr('data-order', String(index));
        $(this).find('a').addClass('link');
      });
      $('.teaser').after('<span class="marker">m</span>');
      $('ul li:last-child').remove();
      return $.html();
    },
    verify: (a, b) => a === b,
    extract: (result) => result.length,
  },
  {
    name: 'serialization (large)',
    input: fixtures.large,
    setup: () => ({ $: null }),
    run: (mod, html) => {
      const $ = mod.load(html);
      return { html: $.html(), xml: mod.xml($.root()), article: $('article').toString() };
    },
    verify: (a, b) => a.html === b.html && a.xml === b.xml && a.article === b.article,
    extract: (result) => result.html.length,
  },
  {
    name: 'cold start + parse + query',
    input: fixtures.small,
    setup: () => ({}),
    run: (mod, html) => {
      delete require.cache[require.resolve(join(here, '..', 'dist', 'index.cjs'))];
      delete require.cache[require.resolve('cheerio-legacy-reference')];
      const fresh = mod === legacy
        ? require(join(here, '..', 'dist', 'index.cjs'))
        : require('cheerio-legacy-reference');
      return fresh.load(html)('article').length;
    },
    verify: (a, b) => a === b,
    extract: (result) => result,
  },
];

const targetSamples = 5;
const warmup = 3;

function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
}

const results = [];
for (const testCase of cases) {
  const times = { legacy: [], oracle: [] };
  let verified = false;
  let outputs;
  for (const engine of ['legacy', 'oracle']) {
    const mod = engine === 'legacy' ? legacy : oracle;
    for (let i = 0; i < warmup; i++) testCase.run(mod, testCase.input);
    for (let i = 0; i < targetSamples; i++) {
      const start = process.hrtime.bigint();
      outputs = testCase.run(mod, testCase.input);
      times[engine].push(Number(process.hrtime.bigint() - start) / 1e6);
    }
  }
  verified = testCase.verify(outputs, outputs); // both engines returned; cross-check below
  const legacyOutput = testCase.run(legacy, testCase.input);
  const oracleOutput = testCase.run(oracle, testCase.input);
  verified = testCase.verify(legacyOutput, oracleOutput);
  const legacyMedian = median(times.legacy);
  const oracleMedian = median(times.oracle);
  results.push({
    name: testCase.name,
    verified,
    legacyMedianMs: +legacyMedian.toFixed(3),
    oracleMedianMs: +oracleMedian.toFixed(3),
    legacyOpsPerSec: +(1000 / legacyMedian).toFixed(1),
    oracleOpsPerSec: +(1000 / oracleMedian).toFixed(1),
    ratio: +(oracleMedian / legacyMedian).toFixed(2),
  });
}

console.log(`Legacy benchmark — cheerox legacy facade vs cheerio@0.22.0 (median of ${targetSamples}, outputs verified)`);
console.log('='.repeat(100));
for (const row of results) {
  const flag = row.verified ? ' ' : '!';
  console.log(
    `${flag} ${row.name.padEnd(32)} cheerox ${String(row.legacyMedianMs).padStart(9)} ms  ` +
    `oracle ${String(row.oracleMedianMs).padStart(9)} ms  ratio ${row.ratio.toFixed(2)}x ` +
    `(cheerox ${row.legacyOpsPerSec}/s, oracle ${row.oracleOpsPerSec}/s)`,
  );
}
const failed = results.filter((row) => !row.verified);
if (failed.length) {
  console.error(`\nOutput verification FAILED for: ${failed.map((row) => row.name).join(', ')}`);
  process.exitCode = 1;
}
