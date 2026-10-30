import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Reject mismatched CPU budgets, fixtures, samples, or failed output checks. */
export function compareReports(before, after) {
  for (const report of [before, after]) {
    assert.deepEqual(report.failures, [], 'Benchmark report contains failures');
    assert.equal(report.metadata.affinityEnforced, true, 'The reported VM comparison requires enforced CPU affinity');
    assert.equal(report.metadata.rounds, 9, 'The recorded comparison requires nine samples');
    assert.equal(report.metadata.quick, false);
    assert.equal(new Set(report.cases.map((row) => row.id)).size, report.cases.length, 'Duplicate case');
  }
  for (const field of ['node', 'platform', 'architecture', 'cpu', 'availableCpus', 'gcPolicy', 'timedScope', 'memoryPolicy', 'fixtureDescription']) {
    assert.equal(before.metadata[field], after.metadata[field], `Unmatched benchmark method/environment: ${field}`);
  }
  assert.deepEqual(before.metadata.toolchain, after.metadata.toolchain, 'Native build compilers differ');
  assert.equal(before.metadata.nativeBuild?.containerImage, after.metadata.nativeBuild?.containerImage, 'Native build images differ');
  assert.equal(before.metadata.nativeBuild?.libc?.buildRuntime, after.metadata.nativeBuild?.libc?.buildRuntime, 'Native build libc baselines differ');
  assert.deepEqual(before.cases.map((row) => row.id).sort(), after.cases.map((row) => row.id).sort(), 'Missing or extra comparison case');
  const rows = after.cases.map((current) => {
    const previous = before.cases.find((row) => row.id === current.id);
    for (const field of ['kind', 'mode', 'size', 'format', 'articles', 'budget', 'documents', 'cycles', 'checkpoint', 'concurrent', 'expectedHash']) assert.equal(previous[field], current[field], `Unmatched case ${current.id}: ${field}`);
    assert.deepEqual(previous.cpuAffinity, current.cpuAffinity, 'CPU affinity changed');
    const engines = {};
    for (const name of ['cheerio', 'cheerox']) {
      const old = previous.engines.find((row) => row.engine === name);
      const now = current.engines.find((row) => row.engine === name);
      assert.ok(old && now, `Missing engine ${name} in ${current.id}`);
      assert.equal(old.inputSha256, now.inputSha256, 'Fixture bytes changed');
      assert.equal(current.engines[0].inputSha256, current.engines[1].inputSha256, 'Engines received different fixtures');
      for (const engine of [old, now]) {
        assert.equal(engine.samples.length, 9);
        for (const sample of engine.samples) assert.equal(sample.actualHash, current.expectedHash, 'Output hash failed');
      }
      const metric = current.kind === 'cold' ? 'coldInitializationAndWorkMs' : 'elapsedMs';
      const previousMedianMs = median(old.samples.map((sample) => sample[metric]));
      const currentMedianMs = median(now.samples.map((sample) => sample[metric]));
      const sampleMedian = (key) => median(now.samples.map((sample) => sample[key]));
      engines[name] = {
        metric, previousMedianMs, currentMedianMs, improvementVsPrevious: previousMedianMs / currentMedianMs,
        medianBaselineRssBytes: sampleMedian('baselineRssBytes'), medianEndRssBytes: sampleMedian('endRssBytes'),
        medianSampledPeakRssBytes: sampleMedian('sampledPeakRssBytes'), medianProcessLifetimePeakRssBytes: sampleMedian('processLifetimePeakRssBytes'),
        medianMaxTimerLagMs: sampleMedian('maxTimerLagMs'), medianTimerTicksDuringWork: sampleMedian('timerTicksDuringWork'),
      };
      if (current.kind === 'retention') {
        engines[name].medianRssGrowthAfterFirstCheckpointBytes = median(now.samples.map((sample) => sample.timeline.at(-1).rssBytes - sample.timeline[0].rssBytes));
        engines[name].medianFinalHeapUsedBytes = median(now.samples.map((sample) => sample.timeline.at(-1).heapUsedBytes));
      }
      if (current.kind === 'concurrent' && name === 'cheerox') {
        for (const sample of now.samples) {
          assert.ok(sample.pool, 'Final concurrent report lacks native worker telemetry');
          assert.ok(sample.pool.peakActiveWorkers <= current.budget);
          assert.equal(sample.pool.activeWorkers, 0);
          assert.equal(sample.pool.activeBatches, 0);
        }
      }
    }
    const speedupVsCheerio = engines.cheerio.currentMedianMs / engines.cheerox.currentMedianMs;
    return { id: current.id, kind: current.kind, mode: current.mode, budget: current.budget, engines, speedupVsCheerio, rustFasterThanCheerio: speedupVsCheerio > 1 };
  });
  return {
    generatedAt: new Date().toISOString(), metadata: {
      node: after.metadata.node, cpu: after.metadata.cpu, availableCpus: after.metadata.availableCpus,
      rounds: 9, affinityEnforced: true, priorRevision: before.metadata.revision,
      currentRevision: after.metadata.revision,
      priorSourceSha256: before.metadata.sourceSha256, currentSourceSha256: after.metadata.sourceSha256,
      priorNativeBinarySha256: before.metadata.nativeBinarySha256,
      currentNativeBinarySha256: after.metadata.nativeBinarySha256,
      currentToolchain: after.metadata.toolchain,
      buildImage: after.metadata.nativeBuild?.containerImage,
      coldMetric: 'Engine import/pool initialization plus first batch; child Node startup and fixture preparation excluded.',
      memoryCaveat: 'Absolute process RSS includes engine/worker initialization and matched input; sampled peaks can miss spikes. Retention growth is final checkpoint RSS minus first checkpoint RSS.',
    },
    caseCount: rows.length, rustWins: rows.filter((row) => row.rustFasterThanCheerio).length,
    rustLosses: rows.filter((row) => !row.rustFasterThanCheerio).map((row) => row.id), cases: rows,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [beforePath, afterPath, outputPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) throw new Error('Usage: node bench/compare.mjs <before.json> <after.json> [output.json]');
  const report = compareReports(JSON.parse(await readFile(beforePath, 'utf8')), JSON.parse(await readFile(afterPath, 'utf8')));
  if (outputPath) await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.table(report.cases.map((row) => ({ case: row.id, cheerioMs: row.engines.cheerio.currentMedianMs.toFixed(2), rustMs: row.engines.cheerox.currentMedianMs.toFixed(2), speedup: row.speedupVsCheerio.toFixed(2), rustVsBefore: row.engines.cheerox.improvementVsPrevious.toFixed(2) })));
  console.log(`${report.rustWins}/${report.caseCount} Rust wins; losses: ${report.rustLosses.join(', ') || '(none)'}`);
}
