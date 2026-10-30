import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fails when an operation loses its lead over Cheerio. Each row compares the
 * end-to-end time of loading a fresh document and running one operation, the
 * cost a caller actually pays, so work an engine defers to first use counts.
 * Ratios come from one process on one machine, which keeps them comparable
 * across runners; the floor leaves room for timing noise.
 *
 *   node bench/gate.mjs
 */
const parityFloor = 0.9;
/** Operations still slower than Cheerio end to end, with the ratio they must not fall below. */
const knownGaps = {
  'html walk with fields': 0.6,
  'xml select compound': 0.75,
  'xml html of selection': 0.8,
  'xml attr via each': 0.6,
  'xml attribs property': 0.65,
  'xml parents count': 0.55,
  'xml parent and siblings': 0.7,
  'xml children and next': 0.6,
  'xml walk children': 0.4,
  'xml walk with fields': 0.25,
  'xml set attributes': 0.7,
  'xml remove elements': 0.65,
  'xml append and prepend': 0.6,
  'xml replace text and html': 0.65,
  'xml mutate then serialize': 0.75,
  'xml per-element attribute rewrite': 0.55,
};

const directory = mkdtempSync(path.join(tmpdir(), 'cheerox-gate-'));
const script = fileURLToPath(new URL('./operations.mjs', import.meta.url));
/** Shared CI runners slow single samples down at random, so an operation below its floor is measured again before it fails. */
const attempts = 3;
const failures = [];
for (const mode of ['html', 'xml']) {
  let pending = undefined;
  let below = [];
  for (let attempt = 0; attempt < attempts && (pending === undefined || pending.size); attempt++) {
    const output = path.join(directory, `${mode}-${attempt}.json`);
    const only = pending ? ['--only', [...pending].join(',')] : [];
    execFileSync(process.execPath, ['--expose-gc', script, '--quick', '--mode', mode, '--json', output, ...only], { stdio: 'inherit' });
    const { rows } = JSON.parse(readFileSync(output, 'utf8'));
    below = rows.filter((row) => row.operation !== 'load').map((row) => {
      const key = `${mode} ${row.operation}`;
      const floor = knownGaps[key] ?? parityFloor;
      return { row, key, floor, ratio: row.cheerioWithLoad / row.cheeroxWithLoad };
    }).filter(({ ratio, floor }) => ratio < floor);
    pending = new Set(below.map(({ row }) => row.operation));
  }
  failures.push(...below.map(({ row, key, floor, ratio }) => `${key} on ${row.page}: ${ratio.toFixed(2)}x, below ${floor}x`));
}
if (failures.length) {
  console.error(`\nPerformance gate failed:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('\nPerformance gate passed.');
