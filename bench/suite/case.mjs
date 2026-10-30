import assert from 'node:assert/strict';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as pause, setImmediate as turn } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { documentOf, mapFor, digest, runSync, streamSummary } from './fixtures.mjs';
import { CheerioPool } from './worker-pool.mjs';

const config = JSON.parse(process.argv[2]);
assert.ok(typeof globalThis.gc === 'function', 'Run benchmark cases with --expose-gc');
const documents = Array.from({ length: config.documents ?? 1 }, (_, index) => documentOf(config.articles, index, config.format === 'xml' || config.mode === 'xml'));
const input = documents[0];
const streamInput = config.kind === 'stream' ? Buffer.from(input) : undefined;
let api, pool;
const startupAt = performance.now();
if (config.engine === 'cheerio' && ['pool', 'concurrent', 'cold'].includes(config.kind)) {
  pool = new CheerioPool(config.budget); await pool.ready;
} else {
  api = await import(config.engine === 'cheerio' ? 'cheerio' : '../../dist/modern.mjs');
  if (config.engine === 'rusteerio' && ['pool', 'cold', 'concurrent'].includes(config.kind)) api.configureWorkers?.(config.budget);
}
const initializationMs = performance.now() - startupAt;

function poolInfo() {
  if (!['pool', 'cold', 'concurrent'].includes(config.kind)) return null;
  const info = pool?.info() ?? api?.workerPoolInfo?.();
  return typeof info === 'string' ? JSON.parse(info) : info ?? null;
}
function assertPoolCap() {
  const info = poolInfo();
  if (config.requireCap && config.engine === 'rusteerio') assert.ok(info, 'Native global worker telemetry must be exported');
  if (info) {
    assert.equal(info.threads, config.budget, 'Configured global worker budget differs');
    assert.ok(info.peakActiveWorkers <= config.budget, `Global pool exceeded ${config.budget}: ${JSON.stringify(info)}`);
    assert.equal(info.activeWorkers, 0);
    if ('activeBatches' in info) assert.equal(info.activeBatches, 0);
  }
  return info;
}
async function collect() {
  await pool?.gc(true); globalThis.gc();
  // Permit WeakRef/finalizer bookkeeping to release abandoned bridge objects.
  await turn(); await turn(); globalThis.gc();
}
async function extract() {
  return pool ? pool.run(documents, config.mode) : api.extractAll(documents, mapFor(config.mode), { threads: config.budget });
}
async function stream() {
  const options = config.format === 'xml' ? { xml: true } : {};
  let resolve, reject;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  const output = api.decodeStream(options, (error, document) => error ? reject(error) : resolve(document));
  const chunkSize = 32768;
  function* chunks() { for (let start = 0; start < streamInput.length; start += chunkSize) yield streamInput.subarray(start, start + chunkSize); }
  await Promise.all([pipeline(Readable.from(chunks()), output), result]);
  return result;
}
function retentionStep($, index) {
  $('main').append(`<article data-i="${index}"><h2>Entry ${index}</h2><a href="/${index}">Link</a><p>Content ${index}</p></article>`);
  const articles = $('article');
  if (articles.length > 32) articles.first().remove();
  $('article').last().attr('updated', 'yes').addClass('live');
}
async function retention() {
  const $ = api.load('<main></main>'); const timeline = [];
  for (let index = 0; index < config.cycles; index++) {
    retentionStep($, index);
    if ((index + 1) % config.checkpoint === 0) {
      await collect();
      timeline.push({ cycles: index + 1, rssBytes: process.memoryUsage.rss(), heapUsedBytes: process.memoryUsage().heapUsed, liveElements: $('article').length });
    }
  }
  return { output: $.html(), timeline };
}

async function operation() {
  if (['pool', 'cold'].includes(config.kind)) return extract();
  if (config.kind === 'concurrent') return Promise.all(Array.from({ length: config.concurrent }, () => extract()));
  if (config.kind === 'sync') return runSync(api, config.mode, config.articles, input);
  if (config.kind === 'stream') return stream();
  if (config.kind === 'retention') return retention();
  throw new Error(`Unknown case kind ${config.kind}`);
}

const samples = [];
if (!['cold', 'stream', 'retention'].includes(config.kind)) {
  const warm = await operation(); assert.equal(digest(warm), config.expectedHash, 'Warm-up output differs');
}
for (let round = 0; round < config.rounds; round++) {
  await collect();
  const baselineRssBytes = process.memoryUsage.rss();
  const baselineHeapBytes = process.memoryUsage().heapUsed;
  let sampledPeakRssBytes = baselineRssBytes, ticks = 0, maxTimerLagMs = 0, next = performance.now() + 5;
  const delay = monitorEventLoopDelay({ resolution: 5 }); delay.enable();
  const timer = setInterval(() => {
    const now = performance.now(); ticks++; maxTimerLagMs = Math.max(maxTimerLagMs, now - next); next = now + 5;
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage.rss());
  }, 5);
  await pause(12); ticks = 0; maxTimerLagMs = 0; next = performance.now() + 5;
  const start = performance.now();
  let actual = await operation();
  const elapsedMs = performance.now() - start;
  const timerTicksDuringWork = ticks;
  const endRssBytes = process.memoryUsage.rss();
  const processLifetimePeakRssBytes = process.resourceUsage().maxRSS * 1024;
  const endHeapBytes = process.memoryUsage().heapUsed;
  sampledPeakRssBytes = Math.max(sampledPeakRssBytes, endRssBytes);
  await pause(8); clearInterval(timer); delay.disable();
  let timeline;
  if (config.kind === 'stream') actual = streamSummary(actual, config.format === 'xml');
  if (config.kind === 'retention') { timeline = actual.timeline; actual = actual.output; }
  // Hashing and correctness assertions are outside timed/operation-memory windows.
  const actualHash = digest(actual);
  assert.equal(actualHash, config.expectedHash, `${config.engine} ${config.kind}/${config.mode} output round ${round}`);
  samples.push({ elapsedMs, ...(config.kind === 'cold' ? { initializationMs, coldInitializationAndWorkMs: initializationMs + elapsedMs } : {}), baselineRssBytes, baselineHeapBytes, endRssBytes, endHeapBytes, sampledPeakRssBytes, processLifetimePeakRssBytes, timerTicksDuringWork, maxTimerLagMs, eventLoopP99Ms: delay.percentile(99) / 1e6, actualHash, pool: assertPoolCap(), ...(timeline ? { timeline } : {}) });
  actual = null;
}
await pool?.close();
console.log(JSON.stringify({ engine: config.engine, initializationMs, fixtureBytes: documents.reduce((size, value) => size + Buffer.byteLength(value), 0), inputSha256: digest(documents), samples }));
