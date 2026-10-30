import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import * as cheerio from 'cheerio';
import { documentOf, digest, mapFor, runSync, streamSummary } from './suite/fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const quick = args.includes('--quick');
const rounds = quick ? 3 : 9;
const output = path.resolve(argument('--output', 'bench/results/fair/latest.json'));
const sections = new Set(argument('--only', 'sync,pools,cold,stream,retention,concurrent').split(','));
const budgets = argument('--budgets', quick ? '1,2' : '1,2,4,8').split(',').map(Number);
assert.ok(budgets.every((value) => Number.isInteger(value) && value > 0 && value <= os.availableParallelism()));
assert.ok(typeof globalThis.gc === 'function', 'Run with node --expose-gc bench/fair.mjs');

function expandCpuList(text) {
  return text.split(',').flatMap((part) => {
    const [first, last = first] = part.split('-').map(Number);
    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
  });
}
const affinity = process.platform === 'linux'
  ? expandCpuList((await readFile('/proc/self/status', 'utf8')).match(/^Cpus_allowed_list:\s*(.+)$/m)[1].trim())
  : [];
async function sourceHashes() {
  const files = ['Cargo.toml', 'Cargo.lock', 'build.rs', 'package.json', 'package-lock.json', 'tsup.config.ts'];
  async function visit(folder) {
    for (const entry of await readdir(path.join(root, folder), { withFileTypes: true })) {
      const relative = `${folder}/${entry.name}`;
      if (entry.isDirectory()) await visit(relative);
      else if (/\.(?:ts|rs|mjs|toml|lock)$/.test(entry.name)) files.push(relative);
    }
  }
  for (const folder of ['src', 'native/src', 'native/vendor', 'bench/suite']) {
    try { await visit(folder); }
    catch (error) { if (folder !== 'native/vendor' || error.code !== 'ENOENT') throw error; }
  }
  files.push('bench/fair.mjs');
  return Object.fromEntries(await Promise.all(files.sort().map(async (file) => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
}
const hashes = await sourceHashes();
const execute = promisify(execFile);
async function version(command, flags) {
  try { return (await execute(command, flags, { cwd: root })).stdout.trim(); }
  catch { return null; }
}
const [rustc, cargo] = await Promise.all([version('rustc', ['--version', '--verbose']), version('cargo', ['--version'])]);
const nativeBinarySha256 = Object.fromEntries(await Promise.all((await readdir(root)).filter((name) => name.endsWith('.node')).sort().map(async (name) => [name, createHash('sha256').update(await readFile(path.join(root, name))).digest('hex')])));
const buildMetadataPath = argument('--native-build', null);
const nativeBuild = buildMetadataPath ? JSON.parse(await readFile(path.resolve(buildMetadataPath), 'utf8')) : null;
if (nativeBuild) {
  assert.ok(nativeBuild.toolchain?.rustc && nativeBuild.toolchain?.cargo, 'Native build metadata requires actual compiler versions');
  assert.deepEqual(nativeBuild.nativeBinarySha256, nativeBinarySha256, 'Native build metadata does not match measured binary bytes');
}
let report = args.includes('--append') ? JSON.parse(await readFile(output, 'utf8')) : {
  generatedAt: new Date().toISOString(),
  metadata: {
    environment: 'VM', node: process.version, platform: process.platform, architecture: process.arch,
    cpu: os.cpus()[0]?.model, availableCpus: os.availableParallelism(), totalMemoryBytes: os.totalmem(),
    kernel: os.release(), v8: process.versions.v8, runtimeGlibc: process.report?.getReport().header.glibcVersionRuntime ?? null,
    toolchain: nativeBuild?.toolchain ?? { rustc, cargo }, benchmarkHostToolchain: { rustc, cargo }, nativeBinarySha256,
    nativeBuild,
    affinityEnforced: affinity.length > 0, rounds, quick,
    reference: 'cheerio 1.2.0', revision: argument('--revision', null),
    cpuBudgetDefinition: 'Entire child process, its main thread, native threads and Node workers share the same N-CPU affinity mask.',
    gcPolicy: 'Both engines force main-heap GC and two event-loop turns before each sample; reused Cheerio workers also receive GC requests. Retention workloads collect every checkpoint.',
    timedScope: 'Warm pools include input/result structured clone for Cheerio and JS/native conversion for Rust. Cold initialization includes engine import and pool initialization, excludes fixture generation and child Node startup.',
    memoryPolicy: 'Each engine/workload runs in an isolated child process. Stream and retention samples each get a fresh process. Sampled RSS can miss peaks; processLifetimePeakRssBytes includes engine initialization and earlier samples.',
    fixtureDescription: 'Deterministic generated news/catalog HTML with tables, lists, UTF-8/entities, and XML feeds with CDATA. No downloaded corpus.',
    sourceSha256: hashes,
  },
  cases: [], failures: [],
};
assert.deepEqual(report.metadata.sourceSha256, hashes, 'Cannot append measurements from different source bytes');
assert.deepEqual(report.metadata.nativeBinarySha256, nativeBinarySha256, 'Cannot append measurements from different native binary bytes');
assert.deepEqual(report.metadata.nativeBuild, nativeBuild, 'Cannot append measurements from different native build metadata');

function configs() {
  const items = [];
  const sizes = quick ? [['tiny', 4], ['medium', 30]] : [['tiny', 20], ['medium', 500], ['large', 5000]];
  if (sections.has('sync')) for (const [size, articles] of sizes) for (const mode of ['query', 'mutations', 'xml', 'crossDocument']) items.push({ kind: 'sync', mode, size, articles, budget: 1 });
  if (sections.has('pools')) for (const budget of budgets) {
    for (const [size, articles] of sizes) items.push({ kind: 'pool', mode: 'simple', size, articles, documents: quick ? 4 : 16, budget });
    items.push({ kind: 'pool', mode: 'nestedCallback', size: 'medium', articles: quick ? 20 : 500, documents: quick ? 4 : 8, budget });
  }
  if (sections.has('cold')) for (const budget of budgets) for (const [size, articles] of quick ? [sizes[0]] : [sizes[0], sizes.at(-1)]) items.push({ kind: 'cold', mode: 'simple', size, articles, documents: quick ? 4 : 16, budget });
  if (sections.has('stream')) for (const budget of [...new Set([budgets[0], budgets.at(-1)])]) for (const format of ['html', 'xml']) items.push({ kind: 'stream', mode: 'decodeStream', format, size: 'large', articles: quick ? 300 : 50000, budget });
  if (sections.has('retention')) items.push({ kind: 'retention', mode: 'boundedLiveDom', articles: 0, cycles: quick ? 200 : 4000, checkpoint: quick ? 50 : 200, budget: 1 });
  if (sections.has('concurrent')) for (const budget of budgets) items.push({ kind: 'concurrent', mode: 'simple', size: 'medium', articles: quick ? 20 : 300, documents: quick ? 4 : 8, concurrent: 8, budget });
  return items;
}
const expected = new Map();
function expectedHash(config) {
  const key = JSON.stringify({ ...config, budget: undefined });
  if (expected.has(key)) return expected.get(key);
  let output;
  if (config.kind === 'sync') output = runSync(cheerio, config.mode, config.articles);
  else if (config.kind === 'stream') output = streamSummary(cheerio.load(documentOf(config.articles, 0, config.format === 'xml'), config.format === 'xml' ? { xml: true } : undefined), config.format === 'xml');
  else if (config.kind === 'retention') {
    const $ = cheerio.load('<main></main>');
    for (let index = Math.max(0, config.cycles - 32); index < config.cycles; index++) {
      $('main').append(`<article data-i="${index}"><h2>Entry ${index}</h2><a href="/${index}">Link</a><p>Content ${index}</p></article>`);
      $('article').last().attr('updated', 'yes').addClass('live');
    }
    output = $.html();
  } else {
    const batch = Array.from({ length: config.documents }, (_, index) => cheerio.load(documentOf(config.articles, index)).extract(mapFor(config.mode)));
    output = config.kind === 'concurrent' ? Array.from({ length: config.concurrent }, () => batch) : batch;
  }
  const result = digest(output); expected.set(key, result); return result;
}
function summarize(samples, field = 'elapsedMs') {
  const values = samples.map((sample) => sample[field]).sort((a, b) => a - b);
  return { medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.ceil(values.length * 0.95) - 1], minMs: values[0], maxMs: values.at(-1) };
}
async function runChild(config) {
  const command = affinity.length ? 'taskset' : process.execPath;
  const commandArgs = [...(affinity.length ? ['-c', affinity.slice(0, config.budget).join(','), process.execPath] : []), '--expose-gc', fileURLToPath(new URL('./suite/case.mjs', import.meta.url)), JSON.stringify(config)];
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, env: { ...process.env, CHEEROX_THREADS: String(config.budget) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 180000);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`Benchmark child exited ${code ?? signal}: ${stderr.replaceAll(root, '<workspace>/').slice(-5000)}`));
      try { resolve({ ...JSON.parse(stdout.trim()), isolatedProcessWallMs: performance.now() - started }); } catch (error) { reject(error); }
    });
  });
}
async function save() { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
for (const [index, config] of configs().entries()) {
  const id = [config.kind, config.mode, config.size ?? '', config.format ?? '', config.budget].join('/');
  if (report.cases.some((row) => row.id === id)) continue;
  const expectedHashValue = expectedHash(config);
  globalThis.gc();
  const engines = index % 2 ? ['cheerox', 'cheerio'] : ['cheerio', 'cheerox'];
  const rows = [];
  for (const engine of engines) {
    const base = { ...config, engine, expectedHash: expectedHashValue, requireCap: args.includes('--require-cap') && config.kind === 'concurrent' };
    try {
      let result;
      if (['cold', 'stream', 'retention'].includes(config.kind)) {
        const processes = [];
        for (let round = 0; round < rounds; round++) processes.push(await runChild({ ...base, rounds: 1 }));
        result = { engine, fixtureBytes: processes[0].fixtureBytes, inputSha256: processes[0].inputSha256, samples: processes.flatMap((process) => process.samples), isolatedProcessWallMs: processes.map((process) => process.isolatedProcessWallMs) };
      } else result = await runChild({ ...base, rounds });
      assert.equal(result.samples.length, rounds);
      rows.push({ ...result, ...summarize(result.samples), ...(config.kind === 'cold' ? { initializationAndWork: summarize(result.samples, 'coldInitializationAndWorkMs') } : {}) });
      console.log(`${id} ${engine}: ${rows.at(-1).medianMs.toFixed(2)} ms${config.kind === 'cold' ? `; cold init+work ${rows.at(-1).initializationAndWork.medianMs.toFixed(2)} ms` : ''}`);
    } catch (error) {
      const failure = { id, engine, error: String(error.message) }; report.failures.push(failure); console.error(JSON.stringify(failure));
    }
    await save();
  }
  rows.sort((a, b) => a.engine.localeCompare(b.engine));
  report.cases.push({ id, ...config, expectedHash: expectedHashValue, cpuAffinity: affinity.slice(0, config.budget), engines: rows, ...(rows.length === 2 ? { speedupVsCheerio: rows.find((row) => row.engine === 'cheerio').medianMs / rows.find((row) => row.engine === 'cheerox').medianMs } : {}) });
  await save();
}
report.completedAt = new Date().toISOString(); await save();
console.log(`Saved ${path.relative(root, output)}; ${report.cases.length} cases, ${report.failures.length} failures`);
if (report.failures.length) process.exitCode = 1;
