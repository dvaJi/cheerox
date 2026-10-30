// Retained memory: parse N real pages, keep every document alive, measure.
//   node --expose-gc run_mem.mjs <lib> [N]
import { LIBS } from './libs.mjs';
import { loadCorpus, procMem, bytes } from './common.mjs';

const [libName, nArg] = process.argv.slice(2);
const N = Number(nArg ?? 1000);
const lib = LIBS[libName];
// Load only the N measured pages so no discarded corpus memory is freed mid-measurement.
const pages = loadCorpus(undefined, N);
const htmlMB = bytes(pages) / 1e6;

const settle = () => { for (let i = 0; i < 4; i++) globalThis.gc(); };
settle();
const before = procMem(), heapBefore = process.memoryUsage();

const docs = [];
const t0 = performance.now();
for (const p of pages) {
  const d = lib.parse(p);
  // Touch the tree once so lazily materialised engines pay their full cost.
  if (libName === 'cheerox' || libName === 'cheerio') d('a').length;
  docs.push(d);
}
const ms = performance.now() - t0;
settle();
const after = procMem(), heapAfter = process.memoryUsage();

console.log(JSON.stringify({
  lib: libName, docs: docs.length, htmlMB: +htmlMB.toFixed(2), parseMs: +ms.toFixed(0),
  retainedRssMB: +(after.rssMB - before.rssMB).toFixed(1),
  retainedHeapMB: +((heapAfter.heapUsed - heapBefore.heapUsed) / 1e6).toFixed(1),
  retainedExternalMB: +((heapAfter.external + heapAfter.arrayBuffers - heapBefore.external - heapBefore.arrayBuffers) / 1e6).toFixed(1),
  rssPerHtmlMB: +((after.rssMB - before.rssMB) / htmlMB).toFixed(2),
  peakRssMB: +after.hwmMB.toFixed(1),
}));
