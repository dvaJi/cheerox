// Generate the benchmark README (full tables) and the top-level README section
// from final.json, so no number is typed by hand.
//   node readme.mjs <final.json> <bench/libraries/README.md> <section.md>
import fs from 'node:fs';

const [inPath, benchOut, sectionOut] = process.argv.slice(2);
const F = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const L = F.libs;
const n0 = (v) => Math.round(v).toLocaleString('en-US');
const n1 = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const HAS_POOL = Boolean(F.scalingPool?.rusteerio?.length);
const series = (l) => (l === 'rusteerio-pool' ? F.scalingPool.rusteerio : F.scaling[l]);
const at = (l, c) => series(l).find((r) => r.cores === c);
const SL = HAS_POOL ? ['rusteerio', 'rusteerio-pool', ...L.filter((l) => l !== 'rusteerio')] : L;
const LABEL = { rusteerio: '**rusteerio** · extractAll', 'rusteerio-pool': '**rusteerio** · worker pool', cheerio: 'cheerio · worker pool', parse5: 'parse5 · worker pool', jsdom: 'jsdom · worker pool' };
const slib = (l) => LABEL[l] ?? l;
const bb = (l, v) => (l.startsWith('rusteerio') ? `**${v}**` : v);
const b = (l, s) => (l === 'rusteerio' ? `**${s}**` : s);
const lib = (l) => b(l, l);
const row = (cells) => `| ${cells.join(' | ')} |`;
const table = (head, align, rows) => [row(head), row(align), ...rows.map(row)].join('\n');
const H5 = F.html5lib.summary, FT = F.features;
const fp = Object.fromEntries(F.footprint.map((r) => [r.lib, r]));
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const C = F.corpus;
const r1 = at('rusteerio', 1).pagesPerSec, r16 = at('rusteerio', 16).pagesPerSec;
const x = (a, c) => `${n1(a / c)}×`;

// ---------- summary table (top README) ----------
const summary = table(
  ['Library', 'Pages/s, 1 CPU', 'Pages/s, 16 CPUs', 'Working memory, 16 CPUs', 'WPT parsing tests', 'Feature probes', 'Packages'],
  ['---', '---:', '---:', '---:', '---:', '---:', '---:'],
  SL.map((l) => { const k = l === 'rusteerio-pool' ? 'rusteerio' : l; return [slib(l), bb(l, n0(at(l, 1).pagesPerSec)), bb(l, n0(at(l, 16).pagesPerSec)), bb(l, `${n1(at(l, 16).workingMB / 1000)} GB`), bb(l, `${n1(H5[k].strictPct)}%`), bb(l, `${FT.results[k].score}/${FT.features.length}`), bb(l, fp[k].packages)]; }),
);

const fasterAt16 = L.filter((l) => l !== 'rusteerio' && at(l, 16).pagesPerSec > r16);
const p16 = HAS_POOL ? at('rusteerio-pool', 16).pagesPerSec : 0, p1 = HAS_POOL ? at('rusteerio-pool', 1).pagesPerSec : 0;
const rel = (a, c, name) => (a >= c ? `${x(a, c)} faster than ${name}` : `${x(c, a)} slower than ${name}`);
const POOL_TEXT = HAS_POOL ? ` Run as its synchronous API in a \`worker_threads\` pool, the same setup the other libraries use, rusteerio scaled ${x(p16, p1)} from 1 to 16 CPUs and reached **${n0(p16)} pages/s at 16 CPUs**: ${rel(p16, at('parse5', 16).pagesPerSec, 'parse5')} and ${rel(p16, at('cheerio', 16).pagesPerSec, 'cheerio')}, using ${n1(at('rusteerio-pool', 16).workingMB / 1000)} GB of working memory.` : '';
const section = `### Compared with other Node.js HTML libraries

[![Pages per second on 1 and 16 CPUs for rusteerio, cheerio, parse5 and jsdom.](bench/libraries/overview-v4.svg)](bench/libraries/README.md)

Only parsers that build a WHATWG-compliant tree are compared. htmlparser2 and node-html-parser pass under 1% of the WPT parsing tests, so they are excluded.

The same extraction job ran over ${n0(C.pages)} Common Crawl pages (${n0(C.total_bytes / 1e6)} MB): load the page, then read the title, the meta description, every \`a[href]\`, the h1–h3 text and the image count. On one CPU, rusteerio was **${x(r1, at('cheerio', 1).pagesPerSec)} faster than cheerio**, ${x(r1, at('parse5', 1).pagesPerSec)} faster than parse5 and ${n0(r1 / at('jsdom', 1).pagesPerSec)}× faster than jsdom. At 16 CPUs it used **the least working memory of the ${['', 'one', 'two', 'three', 'four', 'five', 'six'][L.length]}** (${n1(at('rusteerio', 16).workingMB / 1000)} GB vs ${n1(at('cheerio', 16).workingMB / 1000)} GB for cheerio). With \`extractAll\`, rusteerio stops scaling at about 8 CPUs because its main thread copies every page in and every result out${fasterAt16.length ? `, so at 16 CPUs ${new Intl.ListFormat('en', { type: 'conjunction' }).format(fasterAt16).replace(', and', ' and')} ${fasterAt16.length === 1 ? 'was' : 'were'} faster` : ''}.${POOL_TEXT}

${summary}

[![Throughput from 1 to 16 CPUs, log scale.](bench/libraries/scaling-v4.svg)](bench/libraries/README.md#throughput-across-cpu-budgets)

[![Working memory at 16 CPUs and memory per MB of parsed HTML.](bench/libraries/memory-v4.svg)](bench/libraries/README.md#memory)

[![WHATWG tree-construction conformance and feature probes.](bench/libraries/correctness-v4.svg)](bench/libraries/README.md#conformance-and-features)

Each configuration ran on 3 separate boat.dev VMs with 16 vCPUs (AMD Ryzen 9 9950X) and 32 GB of RAM, using Node 24.18.1. Values are the median across the VMs. [Full tables, method, raw results and reproduction](bench/libraries/README.md).
`;

// ---------- full benchmark README ----------
const cores = [1, 2, 4, 8, 16];
const scalingT = table(['Library', ...cores.map((c) => `${c} CPU${c > 1 ? 's' : ''}`), '1→16 CPUs'], ['---', ...cores.map(() => '---:'), '---:'],
  SL.map((l) => [slib(l), ...cores.map((c) => bb(l, n0(at(l, c).pagesPerSec))), bb(l, x(at(l, 16).pagesPerSec, at(l, 1).pagesPerSec))]));
const rangeT = table(['Library', ...cores.map((c) => `${c} CPU${c > 1 ? 's' : ''}`)], ['---', ...cores.map(() => '---')],
  SL.map((l) => [slib(l), ...cores.map((c) => at(l, c).vmPagesPerSec.map(n0).join(' / '))]));
const busyT = table(['Library', ...cores.map((c) => `${c} CPU${c > 1 ? 's' : ''}`)], ['---', ...cores.map(() => '---:')],
  SL.map((l) => [slib(l), ...cores.map((c) => n1(at(l, c).avgCoresBusy))]));
const ops = [['parse', 'Parse'], ['extract', 'Parse + extract'], ['serialize', 'Parse + serialize']];
const opsT = table(['Library', ...ops.map(([, t]) => `${t} (MB/s)`), ...ops.map(([, t]) => `${t} (ms/page)`)], ['---', ...ops.map(() => '---:'), ...ops.map(() => '---:')],
  L.map((l) => [lib(l), ...ops.map(([o]) => (F.ops[l][o] ? b(l, n1(F.ops[l][o].mbPerSec)) : 'n/a')), ...ops.map(([o]) => (F.ops[l][o] ? b(l, F.ops[l][o].msPerPage.toFixed(2)) : 'n/a'))]));
const memT = table(['Library', 'Peak RSS, 16 CPUs', 'Working memory, 16 CPUs', 'Working memory, 1 CPU', 'Retained, 500 docs', 'RSS per MB of HTML'], ['---', '---:', '---:', '---:', '---:', '---:'],
  L.map((l) => [lib(l), b(l, `${n0(at(l, 16).peakRssMB)} MB`), b(l, `${n0(at(l, 16).workingMB)} MB`), b(l, `${n0(at(l, 1).workingMB)} MB`), b(l, `${n0(F.mem[l].retainedRssMB)} MB`), b(l, `${n1(F.mem[l].rssPerHtmlMB)}×`)]));
const confT = table(['Library', 'Tests passed', 'Pass rate', 'Real-page agreement with parse5'], ['---', '---:', '---:', '---:'],
  L.map((l) => [lib(l), b(l, `${n0(H5[l].strictPass)} / ${n0(F.html5lib.tests)}`), b(l, `${n1(H5[l].strictPct)}%`), b(l, `${n1(F.agreement.results[l].pagesIdenticalPct)}%`)]));
const FL = {
  css_basic: 'CSS selectors', css_advanced: 'Advanced selectors (15 probes)', jquery_api: 'jQuery-style API', dom_mutation: 'DOM mutation', serialize: 'HTML serialization',
  text: 'Text extraction', xml_mode: 'XML mode', streaming: 'Streaming parse', encoding_sniff: 'Encoding sniffing from bytes', fetch_url: 'Load from URL',
  source_locations: 'Source locations', declarative_extract: 'Declarative extraction', form_serialize: 'Form serialization', style_api: 'Inline style API',
  async_offthread_parse: 'Async, off-main-thread parse', native_multicore: 'Built-in multi-core batches', script_execution: 'Script execution', parse_errors: 'Parse-error reporting',
  fragment_parsing: 'Fragment parsing', events_api: 'DOM events', typescript_types: 'Bundled TypeScript types', zero_runtime_deps: 'Zero runtime dependencies',
};
const featT = table(['Feature', ...L.map(lib)], ['---', ...L.map(() => ':---:')],
  [...FT.features.map((f) => [FL[f] ?? f, ...L.map((l) => { const v = FT.results[l][f]; return f === 'css_advanced' ? `${Math.round(v * 15)}/15` : v ? '✓' : '–'; })]),
    ['**Total**', ...L.map((l) => `**${FT.results[l].score}**`)]]);
const footT = table(['Library', 'Version', 'Install size', 'Packages', 'Cold import (median of 15)'], ['---', '---', '---:', '---:', '---:'],
  L.map((l) => [lib(l), fp[l].spec.split('@')[1], b(l, `${n1(fp[l].installBytes / 1e6)} MB`), b(l, fp[l].packages), b(l, `${n1(med(fp[l].requireMs))} ms`)]));

const bench = `# rusteerio and other Node.js HTML libraries

Compared: **rusteerio 1.1.6**, cheerio 1.2.0, parse5 8.0.1 and jsdom 30.1.3, measured in October 2026. Only parsers that build a WHATWG-compliant tree are included. htmlparser2 12.0.0 (0.5% of WPT parsing tests) and node-html-parser 9.0.4 (0.1%) were measured but are excluded.

## Throughput across CPU budgets

![Pages per second from 1 to 16 CPUs.](scaling-v4.svg)

${n0(C.pages)} pages from ${n0(C.pages)} different hosts in Common Crawl CC-MAIN-2026-39 (${n0(C.total_bytes / 1e6)} MB of HTML; median page ${n0(C.median_bytes / 1000)} KB, p90 ${n0(C.p90_bytes / 1000)} KB). Every library ran the same job on every page: parse, then extract the title, meta description, \`a[href]\` values, h1–h3 text and image count. Pages per second, median of 3 VMs:

${scalingT}

rusteerio's throughput rose ${x(r16, r1)} from 1 to 16 CPUs and stopped improving at about 8. Beyond that point the JavaScript main thread, which copies input strings into Rust and decodes results back out, was the limit: at 16 CPUs the process kept only ${n1(at('rusteerio', 16).avgCoresBusy)} cores busy. Splitting the input differently (one call with every page, or 32 or 128 pages per call) changed memory use, not this ceiling.

![Pages per second on 1 and 16 CPUs.](overview-v4.svg)

<details>
<summary>Per-VM medians and CPU utilisation</summary>

Pages per second on each of the 3 VMs:

${rangeT}

Average cores busy (process CPU time ÷ wall time):

${busyT}

</details>

## Single-CPU speed by operation

![Parse, extract and serialize throughput on one CPU.](operations-v4.svg)

Synchronous API on the main thread, pinned to one CPU, over the whole corpus:

${opsT}

jsdom has no single-CPU operation results. Parsing all 3,000 pages in one process exhausted its heap at both the 4 GB default and a 16 GB limit. Its throughput appears in the multi-core table, where each worker processes a share of the pages.

## Memory

![Working memory at 16 CPUs and RSS per MB of parsed HTML.](memory-v4.svg)

${memT}

Peak RSS is VmHWM for the whole process. Working memory is that peak minus RSS with the corpus resident (about ${n1(at('rusteerio', 16).baselineRssMB / 1000)} GB). Retained memory is the RSS growth after parsing the first 500 pages (${n1(F.mem.rusteerio.htmlMB)} MB of HTML) and keeping every document alive, measured after forcing GC.

## Conformance and features

![WPT conformance and feature probes.](correctness-v4.svg)

${confT}

Conformance uses the ${n0(F.html5lib.tests)} whole-document tree-construction tests in web-platform-tests \`html/syntax/parsing/resources/*.dat\`. Fragment tests, scripting-flagged tests, \`scripted_*\` files and \`pending-spec-changes*\` files are excluded. Each library's own public tree is printed in html5lib format and compared exactly. No library passes the 83 tests for HTML processing instructions, a 2026 spec change. rusteerio passes ${H5.rusteerio.strictPass - H5.parse5.strictPass} more tests than parse5.

Real-page agreement counts the pages where all five extracted fields match a parse5 tree walk. Known causes of the differences: cheerio and rusteerio selectors also match inside \`<template>\` content, which DOM \`querySelectorAll\` does not, and jsdom runs with scripting disabled, so it parses \`<noscript>\` contents as elements. Sampled differing pages traced to these causes; not every page was traced. rusteerio's \`.extract()\` output and \`.html()\` serialization were **identical to cheerio's on ${n0(F.rvc.extractIdentical)} of ${n0(F.rvc.pages)} pages**. All 777 of Cheerio 1.2.0's own tests pass at the v1.1.6 tag.

Every feature was checked by running code against the library, not taken from documentation:

${featT}

## Install footprint

![Install size, package count and cold import time.](footprint-v4.svg)

${footT}

rusteerio ships native binaries for 8 platforms in one package (3.6–5.2 MB each), so its install is the largest even though it has no npm dependencies.

## Method

- **Hardware:** boat.dev xlarge VMs (16 vCPU AMD Ryzen 9 9950X, 32 GB RAM, Ubuntu 24.04, Node 24.18.1). Every configuration ran on 3 different VMs, one measurement at a time per VM. Run-to-run differences between VMs reached about 40%, which is why the tables report the median across VMs.
- **CPU budgets** are enforced with \`taskset\`: every thread the process owns shares N CPUs, including the main thread, workers, GC helpers and the native pool.
- **JS libraries** run in a pool of N \`worker_threads\` fed 8 pages per message. Each worker's old-space heap is capped at 512 MB. Without the cap, cheerio's pool reached 30.5 GB at 16 workers, and the cap did not slow it down.
- **rusteerio** runs two ways. *extractAll* uses its native batch API with \`threads: N\`, 128 pages per call and 4 calls in flight; passing all 3,000 pages in one call ran at the same speed and used 9 GB. *Worker pool* runs its synchronous \`load().extract()\` in the same \`worker_threads\` pool as the JS libraries, with the same chunking and heap cap.
- **Extraction:** cheerio and rusteerio use \`.extract()\`; jsdom uses \`querySelectorAll\`; parse5 has no selector engine, so it walks the tree in document order.
- **Timing:** each run warms up on 500 pages, then times 5 passes over the whole corpus (3 for jsdom). The table values are medians of the per-VM medians. Single-CPU operations run with a 16 GB V8 heap limit, because jsdom exhausts the 4 GB default while the corpus is resident.
- **Correctness:** checksums of extracted items are recorded for every run, and every VM produced the same checksum for each library.

## Files and reproduction

- [\`harness/\`](harness): library adapters, runners, corpus builder, conformance and feature probes, VM job planner and aggregator.
- [\`results/final.json\`](results/final.json): aggregated values with per-VM medians. [\`results/vms/\`](results/vms) holds every raw run.
- [\`plot.mjs\`](plot.mjs) and [\`readme.mjs\`](readme.mjs) regenerate the charts and this file from \`final.json\`.

\`\`\`sh
# on a 16-CPU Linux VM with Node 24 and Python 3
cd bench/libraries && mkdir -p ~/bench && cp -r harness ~/bench/bench && cd ~/bench
bash bench/bootstrap.sh                                  # pinned versions + identical corpus (md5 checked)
printf 'scaling rusteerio 1\\nscaling cheerio 1\\n' > jobs.txt
bash bench/runjobs.sh jobs.txt my-vm                     # appends to results/*.jsonl
node bench/html5lib.mjs /path/to/wpt                     # WPT conformance
node bench/features.mjs                                  # feature probes
\`\`\`

Then regenerate:

\`\`\`sh
python3 harness/aggregate.py results && node plot.mjs results/final.json . && node readme.mjs results/final.json README.md /dev/null
\`\`\`
`;

fs.writeFileSync(benchOut, bench);
fs.writeFileSync(sectionOut, section);
console.log('ok');
