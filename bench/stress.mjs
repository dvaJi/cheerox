import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { extractAll, nativeStatus } from '../dist/modern.mjs';

const batchCount = Number(process.env.STRESS_BATCHES ?? 20);
const documentCount = Number(process.env.STRESS_DOCUMENTS ?? 64);
const articleCount = Number(process.env.STRESS_ARTICLES ?? 2000);
const threads = Math.min(8, os.availableParallelism());
for (const value of [batchCount, documentCount, articleCount]) {
  assert.ok(Number.isSafeInteger(value) && value > 0, 'Stress dimensions must be positive integers');
}
assert.equal(nativeStatus().available, true, 'The stress run requires the Rust addon');

const articleHtml = Array.from({ length: articleCount }, (_, i) =>
  `<article data-id="${i}"><h2>Article ${i} &amp; detail</h2><a href="/article/${i}">Read more</a><p>${'Useful content. '.repeat(8)}</p></article>`,
).join('');
const documents = Array.from({ length: documentCount }, (_, i) =>
  `<!doctype html><html><body><h1>Document ${i}</h1>${articleHtml}</body></html>`,
);
const map = { title: 'h1', headings: ['article h2'], links: [{ selector: 'article a', value: 'href' }] };
const expectedHeadings = Array.from({ length: articleCount }, (_, i) => `Article ${i} & detail`);
const expectedLinks = Array.from({ length: articleCount }, (_, i) => `/article/${i}`);
let timerTicks = 0;
let maxTimerLagMs = 0;
let nextTickAt = performance.now() + 5;
let peakObservedRssBytes = process.memoryUsage.rss();
const timer = setInterval(() => {
  const now = performance.now();
  maxTimerLagMs = Math.max(maxTimerLagMs, now - nextTickAt);
  nextTickAt = now + 5;
  timerTicks += 1;
  peakObservedRssBytes = Math.max(peakObservedRssBytes, process.memoryUsage.rss());
}, 5);
const start = performance.now();
try {
  for (let batch = 0; batch < batchCount; batch += 1) {
    const results = await extractAll(documents, map, { threads });
    assert.equal(results.length, documentCount);
    for (const [i, result] of results.entries()) {
      assert.equal(result.title, `Document ${i}`, `batch ${batch}, document order ${i}`);
      assert.deepEqual(result.headings, expectedHeadings);
      assert.deepEqual(result.links, expectedLinks);
    }
  }
} finally {
  clearInterval(timer);
}
assert.ok(timerTicks > 0, 'Timers must execute during native work');
const elapsedMs = performance.now() - start;
const processedDocuments = batchCount * documentCount;
const processedBytes = batchCount * documents.reduce((bytes, html) => bytes + Buffer.byteLength(html), 0);
const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  vmId: process.env.VM_ID ?? null,
  threads,
  batchCount,
  documentCount,
  articleCount,
  processedDocuments,
  processedBytes,
  elapsedMs,
  documentsPerSecond: processedDocuments * 1000 / elapsedMs,
  megabytesPerSecond: processedBytes / 1e6 * 1000 / elapsedMs,
  timerTicks,
  maxTimerLagMs,
  peakObservedRssBytes,
  endRssBytes: process.memoryUsage.rss(),
};
const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0) {
  const outputFile = path.resolve(process.argv[outputIndex + 1]);
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
