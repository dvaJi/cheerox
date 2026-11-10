import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import os from 'node:os';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const median = (xs) => { const a = [...xs].sort((a, b) => a - b); return a[Math.floor(a.length / 2)]; };
const cases = {
  'walk children': ($) => { let count = 0; const walk = (n) => { count++; for (const child of n.children ?? []) walk(child); }; walk($.root()[0]); return count; },
  'walk fields': ($) => { let count = 0; const walk = (n) => { if (n.type === 'tag') count += n.name.length + Object.keys(n.attribs).length; else if (n.type === 'text') count += n.data.length; for (const child of n.children ?? []) walk(child); }; walk($.root()[0]); return count; },
  'select tag': ($) => $('a').length,
  'filter complex': ($) => $('a').filter('[href^="/1"]').length,
  'attributes': ($) => $('a').toArray().map(n => n.attribs.href),
  'batch images': null,
  'batch metadata': null,
};
const html = '<main>' + Array.from({ length: 2000 }, (_, i) => `<article class="card" id="n${i}"><h2>Title ${i}</h2><a href="/${i}">link</a><img src="/${i}.png"><p>text <b>bold</b></p></article>`).join('') + '</main>';
if (args[0] === '--worker') {
  const module = await import(pathToFileURL(resolve(args[1])).href);
  const operation = cases[args[2]];
  const plan = args[2] === 'batch metadata' ? { names: [{ selector: 'img', value: 'name' }], types: [{ selector: 'img', value: 'type' }], title: 'h2' } : { images: [{ selector: 'img', value: 'tagName' }], title: 'h2' };
  const warmups = 5, samples = 10, times = [], isolated = [];
  let result;
  for (let i = 0; i < warmups + samples; i++) {
    const start = performance.now();
    const $ = operation ? module.load(html) : undefined;
    const loaded = performance.now();
    result = operation ? operation($) : await module.extractAll([html], plan, { threads: 1 });
    const end = performance.now();
    if (i >= warmups) { times.push(end - start); isolated.push(end - loaded); }
  }
  console.log(JSON.stringify({ total: median(times), operation: median(isolated), result }));
  process.exit(0);
}
const baseline = arg('--baseline'), candidate = arg('--candidate'), rounds = Number(arg('--rounds', '20'));
if (!baseline || !candidate || !Number.isInteger(rounds) || rounds < 2) throw new Error('Usage: node bench/compare-builds.mjs --baseline PATH/modern.mjs --candidate PATH/modern.mjs [--rounds 20] [--json PATH]');
const selected = arg('--only')?.split(',') ?? Object.keys(cases);
for (const name of selected) if (!Object.hasOwn(cases, name)) throw new Error(`Unknown case: ${name}`);
let seed = 0x12345678;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const quantile = (a, p) => a[Math.floor((a.length - 1) * p)];
const rows = [];
for (const name of selected) {
  const pairs = [];
  for (let round = 0; round < rounds; round++) {
    const results = {};
    const order = round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    for (const version of order) {
      const run = spawnSync(process.execPath, ['--expose-gc', process.argv[1], '--worker', version === 'baseline' ? baseline : candidate, name], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      if (run.status !== 0) throw new Error(`${version}: ${run.stderr || run.stdout}`);
      results[version] = JSON.parse(run.stdout);
    }
    assert.deepEqual(results.candidate.result, results.baseline.result, `${name} output differs`);
    pairs.push({ baseline: results.baseline.total, candidate: results.candidate.total, baselineOperation: results.baseline.operation, candidateOperation: results.candidate.operation });
  }
  const ratios = pairs.map(p => p.baseline / p.candidate);
  const bootstrap = [];
  for (let b = 0; b < 5000; b++) bootstrap.push(median(Array.from({ length: rounds }, () => ratios[Math.floor(random() * rounds)])));
  bootstrap.sort((a, b) => a - b);
  const row = { name, baselineMs: median(pairs.map(p => p.baseline)), candidateMs: median(pairs.map(p => p.candidate)), speedup: median(ratios), interval95: [quantile(bootstrap, .025), quantile(bootstrap, .975)], pairs };
  rows.push(row);
  console.log(`${name}: ${row.baselineMs.toFixed(2)} -> ${row.candidateMs.toFixed(2)} ms; paired median ${row.speedup.toFixed(3)}x (bootstrap 95% ${row.interval95.map(n => n.toFixed(3)).join('–')}x)`);
}
const output = arg('--json');
if (output) writeFileSync(output, JSON.stringify({ rounds, samplesPerProcess: 10, warmupsPerProcess: 5, node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, baseline: resolve(baseline), candidate: resolve(candidate), rows }, null, 2) + '\n');
