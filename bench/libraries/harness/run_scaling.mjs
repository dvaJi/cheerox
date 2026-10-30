// Multi-core throughput: the full extraction job over the whole corpus.
//   node run_scaling.mjs <lib> <cores> <mode> [repeats]
//   mode = native : rusteerio.extractAll with a native thread budget of <cores>
//   mode = pool   : <cores> worker_threads, each running lib.extract (sync API),
//                   pages dispatched dynamically in chunks of CHUNK
// One process per (lib, cores, mode) so memory and thread budgets never leak.
import { Worker } from 'node:worker_threads';
import { loadCorpus, procMem, resetPeak, median, bytes } from './common.mjs';
import { EXTRACT_MAP } from './libs.mjs';

const [lib, coresArg, mode, repeatsArg] = process.argv.slice(2);
const cores = Number(coresArg);
const repeats = Number(repeatsArg ?? 3);
const CHUNK = Number(process.env.CHUNK ?? 8);          // pool: pages per message
const BATCH = Number(process.env.BATCH ?? 0);          // native: pages per extractAll call (0 = all)
const INFLIGHT = Number(process.env.INFLIGHT ?? 2);    // native: concurrent extractAll calls
const HEAP_MB = Number(process.env.HEAP_MB ?? 0);      // pool: per-worker V8 old-space cap (0 = V8 default)

const pages = loadCorpus();
const totalBytes = bytes(pages);
const warm = pages.slice(0, 500);
const baseline = procMem();
resetPeak();

let runOnce, shutdown = async () => {};

if (mode === 'native') {
  const r = await import('rusteerio');
  r.configureWorkers({ threads: cores });
  const shape = (o) => ({ title: o.title, desc: o.desc, links: o.links, headings: o.headings, imgs: o.imgs.length });
  runOnce = async (input) => {
    if (!BATCH) return (await r.extractAll(input, EXTRACT_MAP, { threads: cores })).map(shape);
    const out = new Array(input.length);
    let next = 0;
    const lane = async () => {
      while (next < input.length) {
        const id = next; next += BATCH;
        const res = await r.extractAll(input.slice(id, id + BATCH), EXTRACT_MAP, { threads: cores });
        for (let i = 0; i < res.length; i++) out[id + i] = shape(res[i]);
      }
    };
    await Promise.all(Array.from({ length: INFLIGHT }, lane));
    return out;
  };
} else {
  const workers = Array.from({ length: cores }, () => new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { lib }, ...(HEAP_MB ? { resourceLimits: { maxOldGenerationSizeMb: HEAP_MB } } : {}) }));
  runOnce = (input) => new Promise((resolve) => {
    const out = new Array(input.length);
    let next = 0, done = 0;
    const feed = (w) => {
      if (next >= input.length) return;
      const id = next; next += CHUNK;
      w.postMessage({ id, pages: input.slice(id, id + CHUNK) });
    };
    for (const w of workers) {
      w.removeAllListeners('message');
      w.on('message', ({ id, results }) => {
        for (let i = 0; i < results.length; i++) out[id + i] = results[i];
        done += results.length;
        if (done === input.length) resolve(out); else feed(w);
      });
      feed(w);
    }
  });
  shutdown = () => Promise.all(workers.map((w) => w.terminate()));
}

await runOnce(warm);
const times = [], cpu = [];
let checksum = 0;
for (let i = 0; i < repeats; i++) {
  const c0 = process.cpuUsage(), t0 = performance.now();
  const res = await runOnce(pages);
  const ms = performance.now() - t0, c = process.cpuUsage(c0);
  times.push(ms);
  cpu.push((c.user + c.system) / 1000 / ms);
  checksum = res.reduce((n, o) => n + o.links.length + o.headings.length + o.imgs, 0);
}
const mem = procMem();
await shutdown();

const med = median(times);
console.log(JSON.stringify({
  lib, cores, mode, repeats, chunk: mode === 'pool' ? CHUNK : undefined, heapMB: mode === 'pool' ? HEAP_MB : undefined, batch: mode === 'native' ? BATCH : undefined, inflight: mode === 'native' && BATCH ? INFLIGHT : undefined, pages: pages.length, totalBytes,
  timesMs: times.map((t) => +t.toFixed(1)), medianMs: +med.toFixed(1),
  pagesPerSec: +(pages.length / (med / 1000)).toFixed(1),
  mbPerSec: +(totalBytes / 1e6 / (med / 1000)).toFixed(2),
  avgCoresBusy: +median(cpu).toFixed(2),
  baselineRssMB: +baseline.rssMB.toFixed(1),
  peakRssMB: +mem.hwmMB.toFixed(1),
  checksum,
}));
