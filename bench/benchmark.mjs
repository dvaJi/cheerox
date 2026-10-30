import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import * as cheerox from '../dist/modern.mjs';

const quick = process.argv.includes('--quick');
const outputFlag = process.argv.indexOf('--output');
const outputFile = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined;
const rounds = quick ? 3 : 9;
const batchSize = quick ? 8 : 32;
const threads = Math.min(8, os.availableParallelism());
const extraction = {
  titles: ['article h2'],
  links: [{ selector: 'article a', value: 'href' }],
};
const nativeStatus = cheerox.nativeStatus();
assert.equal(nativeStatus.available, true, `Native Rust addon is required: ${nativeStatus.error ?? ''}`);

function documentOf(articleCount) {
  const articles = Array.from({ length: articleCount }, (_, i) =>
    `<article class="card ${i % 3 === 0 ? 'featured' : ''}" data-id="${i}"><h2>Article ${i} &amp; details</h2><p>Useful text ${i} <strong>with emphasis</strong>.</p><a href="/articles/${i}">Read more</a></article>`,
  ).join('');
  return `<!doctype html><html><head><title>Benchmark</title></head><body><main>${articles}</main></body></html>`;
}

function selectResult(api, html) {
  const $ = api.load(html);
  return {
    count: $('article.featured').length,
    title: $('article.featured h2').first().text(),
    href: $('article a').last().attr('href'),
  };
}

function extractCheerio(html) {
  const $ = cheerio.load(html);
  return {
    titles: $('article h2').map((_, element) => $(element).text()).get(),
    links: $('article a').map((_, element) => $(element).attr('href')).get(),
  };
}

function quantile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function measure(name, fn, expected, sampleRounds = rounds) {
  assert.deepEqual(await fn(), expected, `${name}: correctness warm-up`);
  const times = [];
  for (let i = 0; i < sampleRounds; i += 1) {
    globalThis.gc?.();
    const start = performance.now();
    const actual = await fn();
    const elapsed = performance.now() - start;
    assert.deepEqual(actual, expected, `${name}: result ${i}`);
    times.push(elapsed);
  }
  times.sort((a, b) => a - b);
  return {
    name,
    rounds: sampleRounds,
    medianMs: quantile(times, 0.5),
    p95Ms: quantile(times, 0.95),
    minMs: times[0],
    maxMs: times.at(-1),
  };
}

async function responsiveness(name, fn, expected) {
  const delay = monitorEventLoopDelay({ resolution: 5 });
  let ticks = 0;
  let maxTimerLagMs = 0;
  let nextTickAt = performance.now() + 5;
  const timer = setInterval(() => {
    const now = performance.now();
    maxTimerLagMs = Math.max(maxTimerLagMs, now - nextTickAt);
    nextTickAt = now + 5;
    ticks += 1;
  }, 5);
  delay.enable();
  await pause(15);
  ticks = 0;
  maxTimerLagMs = 0;
  nextTickAt = performance.now() + 5;
  const start = performance.now();
  const actual = await fn();
  const elapsedMs = performance.now() - start;
  const timerTicksDuringWork = ticks;
  // Include the first timer after a blocking workload in the lag measurement.
  await pause(10);
  clearInterval(timer);
  delay.disable();
  assert.deepEqual(actual, expected, `${name}: event-loop result`);
  return {
    name,
    elapsedMs,
    timerTicksDuringWork,
    maxTimerLagMs,
    eventLoopP99Ms: delay.percentile(99) / 1e6,
    eventLoopMaxMs: delay.max / 1e6,
  };
}

const results = {
  generatedAt: new Date().toISOString(),
  metadata: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    availableCpus: os.availableParallelism(),
    totalMemoryBytes: os.totalmem(),
    gcExposed: typeof globalThis.gc === 'function',
    quick,
    threads,
    batchSize,
    vmId: process.env.VM_ID ?? null,
    nativeStatus,
  },
  workloads: [],
  eventLoop: [],
};

for (const [size, articleCount] of [['small', 20], ['medium', 500], ['large', 5000]]) {
  const html = documentOf(articleCount);
  const expected = selectResult(cheerio, html);
  const serial = await measure('cheerio.load + select + text + attr', () => selectResult(cheerio, html), expected);
  const native = await measure('cheerox.load + select + text + attr', () => selectResult(cheerox, html), expected);
  const documents = Array.from({ length: batchSize }, () => html);
  const expectedBatch = documents.map(extractCheerio);
  const batch = [
    await measure('cheerio serial extraction', () => documents.map(extractCheerio), expectedBatch),
    await measure('cheerox.extractAll threads=1', () => cheerox.extractAll(documents, extraction, { threads: 1 }), expectedBatch),
    await measure(`cheerox.extractAll threads=${threads}`, () => cheerox.extractAll(documents, extraction, { threads }), expectedBatch),
  ];
  const workload = {
    size,
    articleCount,
    documentBytes: Buffer.byteLength(html),
    sync: [serial, { ...native, speedupVsCheerio: serial.medianMs / native.medianMs }],
    batch: batch.map((row, i) => ({
      ...row,
      documentsPerSecond: batchSize * 1000 / row.medianMs,
      speedupVsCheerio: i ? batch[0].medianMs / row.medianMs : 1,
    })),
  };
  results.workloads.push(workload);
  console.error(`${size}: ${articleCount} articles, ${workload.documentBytes} bytes`);
  console.table([...workload.sync, ...workload.batch].map((row) => ({
    operation: row.name,
    medianMs: row.medianMs.toFixed(2),
    p95Ms: row.p95Ms.toFixed(2),
    speedup: row.speedupVsCheerio?.toFixed(2) ?? '',
  })));
  if (size === 'large') {
    results.eventLoop.push(
      await responsiveness('cheerio serial extraction', () => documents.map(extractCheerio), expectedBatch),
      await responsiveness('cheerox.extractAll threads=1', () => cheerox.extractAll(documents, extraction, { threads: 1 }), expectedBatch),
      await responsiveness(`cheerox.extractAll threads=${threads}`, () => cheerox.extractAll(documents, extraction, { threads }), expectedBatch),
    );
  }
}

console.table(results.eventLoop.map((row) => ({
  operation: row.name,
  elapsedMs: row.elapsedMs.toFixed(2),
  timerTicksDuringWork: row.timerTicksDuringWork,
  maxTimerLagMs: row.maxTimerLagMs.toFixed(2),
  eventLoopP99Ms: row.eventLoopP99Ms.toFixed(2),
})));
if (outputFile) {
  const target = path.resolve(outputFile);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(results, null, 2)}\n`);
  console.error(`Saved ${path.relative(path.dirname(fileURLToPath(import.meta.url)), target)}`);
} else {
  console.log(JSON.stringify(results, null, 2));
}
