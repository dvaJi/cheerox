import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as cheerio from 'cheerio';
import * as rusteerio from '../dist/index.mjs';

assert.equal(rusteerio.nativeStatus().available, true);
const rounds = process.argv.includes('--quick') ? 3 : 9;
const html = '<main>' + Array.from({ length: 2000 }, (_, i) => `<article class="card ${i % 3 ? '' : 'featured'}"><h2>Article ${i}</h2><p>Body ${i}</p></article>`).join('') + '</main>';
const xml = '<Root>' + Array.from({ length: 4000 }, (_, i) => `<Item Id="${i}"><Title>Item ${i} &amp; detail</Title></Item>`).join('') + '</Root>';

const workloads = {
  mutations(api) {
    const $ = api.load(html);
    $('article').addClass('processed').attr('data-state', 'done');
    $('article.featured').removeClass('featured');
    $('article h2').text('Updated');
    $('article').first().append('<p>Added</p>');
    return $.html();
  },
  xml(api) {
    const $ = api.load(xml, { xml: true });
    $('Item').attr('State', 'ready');
    $('Item').first().append('<Child/>');
    return { count: $('Item:contains(detail)').length, output: $.xml() };
  },
  crossDocumentMove(api) {
    const source = api.load(html);
    const target = api.load('<section></section>');
    const retained = source('article');
    target('section').append(retained);
    retained.first().attr('moved', 'yes');
    return { source: source.html(), target: target.html(), text: retained.first().text() };
  },
};

const results = {
  generatedAt: new Date().toISOString(),
  metadata: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    cpu: os.cpus()[0]?.model,
    availableCpus: os.availableParallelism(),
    vmId: process.env.VM_ID ?? null,
    gcExposed: typeof globalThis.gc === 'function',
    htmlArticles: 2000,
    xmlItems: 4000,
  },
  rounds,
  workloads: [],
};
for (const [name, workload] of Object.entries(workloads)) {
  const expected = workload(cheerio);
  const rows = [];
  for (const [engine, api] of [['cheerio', cheerio], ['rusteerio', rusteerio]]) {
    assert.deepEqual(workload(api), expected, `${name} ${engine} warm-up`);
    const timings = [];
    for (let round = 0; round < rounds; round++) {
      globalThis.gc?.();
      const start = performance.now();
      const result = workload(api);
      timings.push(performance.now() - start);
      assert.deepEqual(result, expected, `${name} ${engine} round ${round}`);
    }
    timings.sort((a, b) => a - b);
    rows.push({ engine, medianMs: timings[Math.floor(timings.length / 2)], p95Ms: timings.at(-1), samplesMs: timings });
  }
  const row = { name, timings: rows, speedup: rows[0].medianMs / rows[1].medianMs };
  results.workloads.push(row);
  console.log(`${name}: Cheerio ${rows[0].medianMs.toFixed(2)} ms; Rust ${rows[1].medianMs.toFixed(2)} ms; ${row.speedup.toFixed(2)}x`);
}
const output = process.argv.indexOf('--output');
if (output >= 0) {
  const target = path.resolve(process.argv[output + 1]);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(results, null, 2) + '\n');
}
