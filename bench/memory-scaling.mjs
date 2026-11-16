/**
 * Memory scaling benchmark: loads documents in a loop and tracks RSS growth
 * plus per-document retention, with and without keeping documents alive.
 *
 *   node --expose-gc bench/memory-scaling.mjs [documents]
 *
 * Modes:
 *   released — every document is dropped after verification; RSS should stay
 *              flat apart from allocator slack, and the engine's deferred
 *              reclamation (release thread + GC) is what keeps it so.
 *   retained — every document is kept in an array; RSS growth divided by the
 *              document count estimates the retained bytes per document.
 *
 * Diagnostic only: process RSS is a coarse high-water mark, not a per-object
 * measurement. Run with --expose-gc for the GC lines to mean anything.
 */
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cheerox = require('../dist/modern.cjs');

const total = Number(process.argv[2] || 10_000);
const batch = 500;

function generatePage(index) {
  const cards = 20;
  const parts = [`<!doctype html><html><head><title>Bench ${index}</title></head><body><main>`];
  for (let i = 0; i < cards; i++) {
    parts.push(
      `<article class="card" id="c-${index}-${i}"><h2>Doc ${index} card ${i}</h2>` +
      `<p class="t">Text &amp; summary.</p><a href="/a/${i}">Read</a><img src="/i/${i}.png" alt="i">` +
      `<ul><li>t${i % 5}</li><li>t${(i + 2) % 5}</li></ul></article>`,
    );
  }
  parts.push('</main><footer>end</footer></body></html>');
  return parts.join('');
}

const pages = Array.from({ length: total }, (_, i) => generatePage(i));
const mb = (bytes) => (bytes / 1048576).toFixed(1);
const gc = typeof globalThis.gc === 'function' ? () => globalThis.gc() : null;

function sample(label, docsDone) {
  const usage = process.memoryUsage();
  console.log(
    `${label.padEnd(14)} docs ${String(docsDone).padStart(5)}  ` +
    `rss ${mb(usage.rss)} MB  heap ${mb(usage.heapUsed)} MB  ext ${mb(usage.external)} MB`,
  );
  return usage;
}

async function run(mode) {
  console.log(`\n=== ${mode} mode (${total} documents of 20 cards) ===`);
  gc?.();
  const startRss = process.memoryUsage().rss;
  sample('start', 0);
  const retained = [];
  const start = performance.now();
  let checked = 0;
  for (let i = 0; i < total; i++) {
    const $ = cheerox.load(pages[i]);
    if ($('h2').length !== 20) throw new Error(`verification failed at ${i}`);
    checked += 20;
    if (mode === 'retained') retained.push($.root()[0]);
    if ((i + 1) % batch === 0) {
      gc?.();
      sample(`after ${(i + 1)}`, i + 1);
    }
  }
  const elapsed = performance.now() - start;
  gc?.();
  const endRss = process.memoryUsage().rss;
  console.log(
    `total ${total} docs in ${elapsed.toFixed(0)} ms (${(total / (elapsed / 1000)).toFixed(0)} docs/s), ` +
    `h2 verified ${checked}, rss growth ${mb(endRss - startRss)} MB` +
    (mode === 'retained' ? `, retained ${((endRss - startRss) / total / 1024).toFixed(1)} KB/doc average (coarse)` : ''),
  );
  retained.length = 0;
  gc?.();
  const settled = process.memoryUsage().rss;
  console.log(`rss after release+gc: ${mb(settled)} MB (delta from start ${mb(settled - startRss)} MB)`);
}

gc?.();
await run('released');
await run('retained');
console.log('\nDiagnostic: RSS is a process high-water mark; use a real profiler for per-object attribution.');
