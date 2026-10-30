import assert from 'node:assert/strict';
import test from 'node:test';
import { compareReports } from './compare.mjs';

function fixture() {
  const engine = (name, elapsedMs) => ({ engine: name, inputSha256: 'same-input', samples: Array.from({ length: 9 }, () => ({ actualHash: 'same-output', elapsedMs })) });
  return {
    metadata: { affinityEnforced: true, rounds: 9, quick: false, node: 'v24', cpu: 'same-cpu' }, failures: [],
    cases: [{ id: 'sync/query/tiny//1', kind: 'sync', mode: 'query', size: 'tiny', articles: 20, budget: 1, expectedHash: 'same-output', cpuAffinity: [0], engines: [engine('cheerio', 2), engine('cheerox', 1)] }],
  };
}
test('comparison keeps both engines and reports a measured loss', () => {
  const before = fixture(), after = fixture();
  for (const sample of after.cases[0].engines[1].samples) sample.elapsedMs = 4;
  const result = compareReports(before, after);
  assert.equal(result.cases[0].speedupVsCheerio, 0.5);
  assert.equal(result.cases[0].engines.cheerox.improvementVsPrevious, 0.25);
  assert.deepEqual(result.rustLosses, ['sync/query/tiny//1']);
});
test('comparison rejects different inputs, budgets, omitted cases, and failed outputs', () => {
  for (const change of [
    (report) => { report.cases[0].engines[0].inputSha256 = 'different-input'; },
    (report) => { report.cases[0].cpuAffinity = [1]; },
    (report) => { report.cases = []; },
    (report) => { report.cases[0].engines[0].samples[0].actualHash = 'different-output'; },
    (report) => { report.metadata.toolchain = { rustc: 'different', cargo: 'different' }; },
    (report) => { report.metadata.nativeBuild = { containerImage: 'different' }; },
    (report) => { report.metadata.nativeBuild = { libc: { buildRuntime: 'different' } }; },
  ]) {
    const before = fixture(), after = fixture(); change(after);
    assert.throws(() => compareReports(before, after));
  }
});
test('cold comparison includes initialization and first work in its speedup', () => {
  const before = fixture(), after = fixture();
  for (const report of [before, after]) {
    report.cases[0].kind = 'cold';
    for (const row of report.cases[0].engines) for (const sample of row.samples) sample.coldInitializationAndWorkMs = row.engine === 'cheerio' ? 150 : 5;
  }
  assert.equal(compareReports(before, after).cases[0].speedupVsCheerio, 30);
});
