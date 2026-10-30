import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import * as cheerox from '../dist/modern.mjs';

/**
 * Runs a typical scraping job on every page of a corpus with both engines:
 * load, metadata, headings, links, images and their context, structured data,
 * cleanup, text and serialization. Outputs must match exactly; times include
 * loading. After a warm-up, each page reports the median of five samples per
 * engine, alternating which engine runs first. A sample repeats the job until
 * it lasts about a millisecond, so timer resolution and single collection
 * pauses do not decide small pages.
 *
 *   node bench/corpus.mjs <corpus directory> [--json report.json]
 */
const [directory, ...rest] = process.argv.slice(2);
const jsonIndex = rest.indexOf('--json');
const { pages } = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));

function job(engine, html) {
  const $ = engine.load(html);
  const result = {
    title: $('title').first().text().trim(),
    description: $('meta[name="description"]').attr('content') ?? null,
    image: $('meta[property="og:image"]').attr('content') ?? null,
    canonical: $('link[rel="canonical"]').attr('href') ?? null,
    headings: $('h1, h2, h3').map((_, element) => $(element).text().trim()).get().slice(0, 50),
    links: $('a[href]').map((_, element) => $(element).attr('href')).get().length,
    navigation: $('nav a, header a').length,
    images: $('img').map((_, element) => ({ src: $(element).attr('src') ?? null, alt: $(element).attr('alt') ?? null, isLinked: $(element).closest('a').length > 0, depth: $(element).parents().length })).get().slice(0, 100),
    structuredData: $('script[type="application/ld+json"]').map((_, element) => $(element).text().length).get(),
    paragraphs: $('p').filter((_, element) => $(element).text().length > 40).length,
    elements: $('*').length,
  };
  $('script, style, noscript, iframe').remove();
  result.text = $('body').text().replace(/\s+/g, ' ').trim().length;
  result.html = $.html().length;
  return result;
}

const repeats = 5;
const sampleMs = 1;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const documents = pages.map((page) => ({ ...page, html: readFileSync(path.join(directory, page.file), 'utf8') }));
// Warm both engines' code paths before timing.
for (const page of documents.slice(0, 50)) { job(cheerio, page.html); job(cheerox, page.html); }

const rows = [];
const mismatches = [];
for (const [index, page] of documents.entries()) {
  const expected = job(cheerio, page.html);
  try { assert.deepEqual(job(cheerox, page.html), expected); }
  catch { mismatches.push(page.url); continue; }
  const times = new Map([[cheerio, []], [cheerox, []]]);
  const probe = process.hrtime.bigint();
  job(cheerio, page.html);
  const runs = Math.max(1, Math.ceil(sampleMs / (Number(process.hrtime.bigint() - probe) / 1e6)));
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const engine of (index + repeat) % 2 ? [cheerox, cheerio] : [cheerio, cheerox]) {
      const start = process.hrtime.bigint();
      for (let run = 0; run < runs; run++) job(engine, page.html);
      times.get(engine).push(Number(process.hrtime.bigint() - start) / 1e6 / runs);
    }
  }
  rows.push({ url: page.url, bytes: page.bytes, cheerio: median(times.get(cheerio)), cheerox: median(times.get(cheerox)) });
}

const percentile = (values, fraction) => values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
const speedups = rows.map((row) => row.cheerio / row.cheerox).sort((a, b) => a - b);
const total = (field) => rows.reduce((sum, row) => sum + row[field], 0);
const summary = {
  pages: pages.length,
  compared: rows.length,
  mismatched: mismatches.length,
  totalCheerioMs: Math.round(total('cheerio')),
  totalCheeroxMs: Math.round(total('cheerox')),
  overallSpeedup: +(total('cheerio') / total('cheerox')).toFixed(2),
  fasterOnPages: rows.filter((row) => row.cheerox < row.cheerio).length,
  speedupP10: +percentile(speedups, 0.1).toFixed(2),
  speedupP50: +percentile(speedups, 0.5).toFixed(2),
  speedupP90: +percentile(speedups, 0.9).toFixed(2),
  slowestSpeedup: +speedups[0].toFixed(2),
};
console.log(summary);
if (mismatches.length) console.log('mismatched pages:', mismatches.slice(0, 20));
console.log('slowest pages:', rows.map((row) => ({ url: row.url, bytes: row.bytes, speedup: +(row.cheerio / row.cheerox).toFixed(2) })).sort((a, b) => a.speedup - b.speedup).slice(0, 5));
if (jsonIndex >= 0) writeFileSync(rest[jsonIndex + 1], `${JSON.stringify({ summary, mismatches, rows }, null, 2)}\n`);
