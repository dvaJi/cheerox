/**
 * Installation profile: what a consumer actually downloads and pays at
 * require time.
 *
 *   node bench/install-profile.mjs
 *
 * Reports the packed tarball size, per-target binary sizes, and cold
 * require()/ESM-import/first-load timings measured in fresh child
 * processes. Diagnostic only.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const binaries = readdirSync(root)
  .filter((name) => name.startsWith('cheerox.') && name.endsWith('.node'))
  .map((name) => ({ name, mb: statSync(join(root, name)).size / 1048576 }))
  .sort((a, b) => b.mb - a.mb);

let tarballMb = null;
try {
  // --ignore-scripts: skip the prepack rebuild so the measured tarball is
  // the one already on disk and concurrent builds are not triggered.
  const out = execFileSync('npm', ['pack', '--ignore-scripts', '--dry-run'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const match = /package size[^\d]+([\d.]+)\s*(\w+)/.exec(out);
  if (match) {
    const factor = match[2] === 'GB' ? 1024 : match[2] === 'B' ? 1 / 1048576 : 1;
    tarballMb = Number(match[1]) * factor;
  }
} catch (error) {
  console.log(`npm pack --dry-run failed (${String(error).slice(0, 80)}); tarball size unavailable`);
}

console.log(`Native binaries present: ${binaries.length}`);
for (const binary of binaries) console.log(`  ${binary.name.padEnd(34)} ${binary.mb.toFixed(2)} MB`);
if (binaries.length) console.log(`Total binary payload: ${binaries.reduce((sum, b) => sum + b.mb, 0).toFixed(2)} MB`);
if (tarballMb !== null) console.log(`Packed tarball size: ${tarballMb.toFixed(2)} MB`);

const cjsProbe = `
const { performance } = require('node:perf_hooks');
const start = performance.now();
const cheerox = require('@dvaji/cheerox');
const afterRequire = performance.now();
const $ = cheerox.load('<main><a href="/x">x</a></main>');
const afterLoad = performance.now();
console.log('requireMs=' + (afterRequire - start).toFixed(1));
console.log('firstLoadMs=' + (afterLoad - afterRequire).toFixed(1));
`;
const cjsOut = execFileSync(process.execPath, ['-e', cjsProbe], { cwd: root, encoding: 'utf8' });
console.log('Cold require (fresh process):');
console.log(cjsOut.trim().split('\n').map((line) => `  ${line}`).join('\n'));

const esmFile = join(root, '.esm-probe.mjs');
const esmProbe = `
import { performance } from 'node:perf_hooks';
const start = performance.now();
const cheerox = await import('@dvaji/cheerox');
const afterImport = performance.now();
const $ = cheerox.load('<p>x</p>');
const afterLoad = performance.now();
console.log('importMs=' + (afterImport - start).toFixed(1));
console.log('firstLoadMs=' + (afterLoad - afterImport).toFixed(1));
`;
writeFileSync(esmFile, esmProbe);
try {
  const esmOut = execFileSync(process.execPath, [esmFile], { cwd: root, encoding: 'utf8' });
  console.log('Cold ESM import (fresh process):');
  console.log(esmOut.trim().split('\n').map((line) => `  ${line}`).join('\n'));
} finally {
  unlinkSync(esmFile);
}
