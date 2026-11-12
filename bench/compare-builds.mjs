import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const median = (xs) => { const a = [...xs].sort((a, b) => a - b); return a[Math.floor(a.length / 2)]; };
const wideMap = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`field${i}`, { selector: 'a', value: 'href' }]));
const mixedMap = { ...wideMap, callback: { selector: 'p', value: (node) => node.name } };
const shortMap = { title: 'h2', link: { selector: 'a', value: 'href' } };
const cases = {
  'load only': () => 0,
  'serialize document': ($) => $.html(),
  'export tree': ($) => $.root()[Symbol.for('cheerox.selection.document')].exportTree(),
  'walk children': ($) => { let count = 0; const walk = (n) => { count++; for (const child of n.children ?? []) walk(child); }; walk($.root()[0]); return count; },
  'walk fields': ($) => { let count = 0; const walk = (n) => { if (n.type === 'tag') count += n.name.length + Object.keys(n.attribs).length; else if (n.type === 'text') count += n.data.length; for (const child of n.children ?? []) walk(child); }; walk($.root()[0]); return count; },
  'parents count': ($) => $('li').toArray().reduce((total, element) => total + $(element).parents().length, 0),
  'parent and siblings': ($) => $('b').toArray().reduce((total, element) => total + $(element).parent().siblings().length, 0),
  'children and next': ($) => $('ul').toArray().reduce((total, element) => total + $(element).children().first().next().length, 0),
  'select tag': ($) => $('a').length,
  'materialize selection': ($) => $('a').toArray().length,
  'materialize subset': ($) => $('a').slice(0, 64).toArray().length,
  'materialize repeated': ($) => { const node = $('a').first()[0]; return $(Array(64).fill(node)).toArray().length; },
  'filter complex': ($) => $('a').filter('[href^="/1"]').length,
  'attributes': ($) => $('a').toArray().map(n => n.attribs.href),
  'set attributes': ($) => { $('a').attr('data-seen', 'yes'); return $('a[data-seen="yes"]').length; },
  'data values': ($) => { const node = $('a').first(); node.data('value', { text: '\ud800', other: 'ordinary' }); return node.data('value'); },
  'data scalar': ($) => { const node = $('a').first(); for (let i = 0; i < 100; i++) node.data('value', i); return node.data('value'); },
  'extract wide': ($) => $.extract(wideMap),
  'extract mixed': ($) => $.extract(mixedMap),
  'extract short': ($) => $.extract(shortMap),
  'mixed documents': ($, module) => { const other = module.load(html, options); return $('a').first().add(other('a').last()).filter(':last').attr('href'); },
  'batch images': null,
  'batch metadata': null,
};
const cards = Number(arg('--cards', '2000'));
const mode = arg('--mode', 'html');
if (!Number.isInteger(cards) || cards < 1 || !['html', 'xml', 'htmlparser2'].includes(mode)) throw new Error('Invalid --cards or --mode');
const options = mode === 'xml' ? { xml: true } : mode === 'htmlparser2' ? { xml: { xmlMode: false } } : undefined;
const file = arg('--file');
const html = file ? readFileSync(resolve(file), 'utf8') : '<main>' + Array.from({ length: cards }, (_, i) => `<article class="card" id="n${i}"><h2>Title ${i}</h2><a href="/${i}">link</a><img src="/${i}.png"/><p>text <b>bold</b></p></article>`).join('') + '</main>';
if (args[0] === '--worker') {
  const module = await import(pathToFileURL(resolve(args[1])).href);
  const operation = cases[args[2]];
  const plan = args[2] === 'batch metadata' ? { names: [{ selector: 'img', value: 'name' }], types: [{ selector: 'img', value: 'type' }], title: 'h2' } : { images: [{ selector: 'img', value: 'tagName' }], title: 'h2' };
  const warmups = 5, samples = 10, times = [], isolated = [];
  let result;
  for (let i = 0; i < warmups + samples; i++) {
    const start = performance.now();
    const $ = operation ? module.load(html, options) : undefined;
    const loaded = performance.now();
    result = operation ? operation($, module) : await module.extractAll([html], plan, { ...options, threads: 1 });
    const end = performance.now();
    if (i >= warmups) { times.push(end - start); isolated.push(end - loaded); }
  }
  if (args[2] === 'export tree') {
    const records = JSON.parse(result);
    const base = records[0]?.id ?? 0;
    const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
    result = canonical(records.map((record) => ({ ...record, id: record.id - base, children: record.children.map((id) => id - base), parent: record.parent == null ? null : record.parent - base, prev: record.prev == null ? null : record.prev - base, next: record.next == null ? null : record.next - base })));
  }
  console.log(JSON.stringify({ total: median(times), operation: median(isolated), peakRssKiB: process.resourceUsage().maxRSS, result: serialize(result).toString('base64') }));
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
      const run = spawnSync(process.execPath, ['--expose-gc', process.argv[1], '--worker', version === 'baseline' ? baseline : candidate, name, '--cards', String(cards), '--mode', mode, ...(file ? ['--file', resolve(file)] : [])], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      if (run.status !== 0) throw new Error(`${version}: ${run.stderr || run.stdout}`);
      results[version] = JSON.parse(run.stdout);
    }
    if (name === 'export tree') assert.deepEqual(deserialize(Buffer.from(results.candidate.result, 'base64')), deserialize(Buffer.from(results.baseline.result, 'base64')), `${name} output differs`);
    else assert.deepEqual(results.candidate.result, results.baseline.result, `${name} output differs`);
    pairs.push({ baseline: results.baseline.total, candidate: results.candidate.total, baselineOperation: results.baseline.operation, candidateOperation: results.candidate.operation, baselinePeakRssKiB: results.baseline.peakRssKiB, candidatePeakRssKiB: results.candidate.peakRssKiB });
  }
  const summarize = (ratios) => {
    const bootstrap = [];
    for (let b = 0; b < 5000; b++) bootstrap.push(median(Array.from({ length: rounds }, () => ratios[Math.floor(random() * rounds)])));
    bootstrap.sort((a, b) => a - b);
    return { speedup: median(ratios), interval95: [quantile(bootstrap, .025), quantile(bootstrap, .975)] };
  };
  const total = summarize(pairs.map(p => p.baseline / p.candidate));
  const operation = name === 'load only' ? undefined : summarize(pairs.map(p => p.baselineOperation / p.candidateOperation));
  const row = { name, baselineMs: median(pairs.map(p => p.baseline)), candidateMs: median(pairs.map(p => p.candidate)), baselinePeakRssKiB: median(pairs.map(p => p.baselinePeakRssKiB)), candidatePeakRssKiB: median(pairs.map(p => p.candidatePeakRssKiB)), ...total, operation, pairs };
  rows.push(row);
  console.log(`${name}: ${row.baselineMs.toFixed(2)} -> ${row.candidateMs.toFixed(2)} ms; paired median ${row.speedup.toFixed(3)}x (bootstrap 95% ${row.interval95.map(n => n.toFixed(3)).join('–')}x)`);
  if (operation) console.log(`  operation only: ${operation.speedup.toFixed(3)}x (bootstrap 95% ${operation.interval95.map(n => n.toFixed(3)).join('–')}x)`);
  console.log(`  process peak RSS (median): ${(row.baselinePeakRssKiB / 1024).toFixed(1)} -> ${(row.candidatePeakRssKiB / 1024).toFixed(1)} MiB`);
}
const output = arg('--json');
if (output) {
  const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const artifact = (entry) => {
    const module = resolve(entry), directory = dirname(module), root = dirname(directory);
    const bundleFiles = readdirSync(directory).filter(name => /\.(?:mjs|cjs|js)$/.test(name)).sort();
    return { module, moduleSha256: hash(module), bundleFiles: bundleFiles.map(name => ({ name, sha256: hash(join(directory, name)) })), nativeBinaries: readdirSync(root).filter(name => name.endsWith('.node')).sort().map(name => ({ name, sha256: hash(join(root, name)) })) };
  };
  writeFileSync(output, JSON.stringify({ rounds, cards: file ? undefined : cards, file: file ? resolve(file) : undefined, inputSha256: createHash('sha256').update(html).digest('hex'), mode, samplesPerProcess: 10, warmupsPerProcess: 5, node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, baseline: artifact(baseline), candidate: artifact(candidate), rows }, null, 2) + '\n');
}
