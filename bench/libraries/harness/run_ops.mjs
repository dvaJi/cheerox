// Single-thread operation timing on the main thread.
//   node run_ops.mjs <lib> <op> [repeats]     op = parse | extract | serialize
import { LIBS } from './libs.mjs';
import { loadCorpus, median, bytes } from './common.mjs';

const [libName, op, repeatsArg] = process.argv.slice(2);
const repeats = Number(repeatsArg ?? 5);
const lib = LIBS[libName];
const fn = lib[op];
const pages = loadCorpus();

// jsdom documents hold a window; close them so parse-only does not accumulate.
const sink = op === 'parse' && libName === 'jsdom' ? (d) => d.window.close() : () => {};

for (const p of pages.slice(0, 500)) sink(fn(p));
const times = [];
for (let r = 0; r < repeats; r++) {
  const t0 = performance.now();
  for (const p of pages) sink(fn(p));
  times.push(performance.now() - t0);
}
const med = median(times);
console.log(JSON.stringify({
  lib: libName, op, repeats, pages: pages.length,
  timesMs: times.map((t) => +t.toFixed(1)), medianMs: +med.toFixed(1),
  msPerPage: +(med / pages.length).toFixed(4),
  mbPerSec: +(bytes(pages) / 1e6 / (med / 1000)).toFixed(2),
}));
