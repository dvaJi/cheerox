// Render README charts (SVG) in the cheerox benchmark style from final.json.
//   node charts/plot.mjs results/final.json <out-dir>
import fs from 'node:fs';

const [inPath, outDir] = process.argv.slice(2);
const F = JSON.parse(fs.readFileSync(inPath, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

const BLUE = '#2563eb', INK = '#11162b', INK2 = '#344054', MUTED = '#697586', GRID = '#eef0f3';
// one fixed shade per library so identity holds across every chart
const SHADE = { 'cheerox-pool': '#93b4f8', cheerox: BLUE, cheerio: '#344054', parse5: '#5b6576', jsdom: '#7a8597', 'node-html-parser': '#98a2b3', htmlparser2: '#b4bcc8' };
const NAME = { 'cheerox-pool': 'cheerox · worker pool', cheerox: 'cheerox', cheerio: 'cheerio', jsdom: 'jsdom', htmlparser2: 'htmlparser2', parse5: 'parse5', 'node-html-parser': 'node-html-parser' };
const n0 = (v) => Math.round(v).toLocaleString('en-US');
const n1 = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const T = (x, y, s, { size = 15, fill = INK, anchor = 'start', weight = 400 } = {}) =>
  `<text x="${x}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
const STAMP = `${F.corpus.pages.toLocaleString('en-US')} Common Crawl pages (${n0(F.corpus.total_bytes / 1e6)} MB) · median of 3 boat.dev VMs (16 vCPU Ryzen 9 9950X) · October 2026`;

function frame(w, h, title, body, foot) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="${BLUE}"/><rect x="8" y="8" width="${w - 16}" height="${h - 16}" fill="#ffffff"/>
${T(56, 62, title, { size: 28, weight: 700 })}
${body}
${foot.map((l, i) => T(56, h - 40 + i * 15 - (foot.length - 1) * 15, l, { size: 12, fill: MUTED })).join('\n')}
</svg>`;
}

// Ranked horizontal bars; cheerox blue, others slate by rank.
function bars(x, y, w, { title, sub, rows, fmt, max, rowH = 52, labelW = 150, names = NAME }) {
  let s = T(x + labelW, y, title, { size: 17 }) + (sub ? T(x + labelW, y + 21, sub, { size: 15, fill: INK2 }) : '');
  const top = y + (sub ? 44 : 22), plotW = w - labelW - 90;
  max = max ?? Math.max(...rows.map((r) => r.v));
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const gx = x + labelW + plotW * t;
    s += `<line x1="${gx}" x2="${gx}" y1="${top}" y2="${top + rows.length * rowH}" stroke="${GRID}"/>`;
  }
  rows.forEach((r, i) => {
    const by = top + i * rowH + 10, bw = Math.max(2, (plotW * r.v) / max);
    const color = SHADE[r.lib];
    s += T(x + labelW - 8, by + 21, names[r.lib], { size: 15, anchor: 'end' });
    s += `<rect x="${x + labelW}" y="${by}" width="${bw}" height="32" fill="${color}"/>`;
    s += T(x + labelW + bw + 7, by + 21, fmt(r.v), { size: 14 });
  });
  return s;
}

// frame height fits the number of bar rows
const HAS_POOL = Boolean(F.scalingPool?.cheerox?.length);
const SPEED_LIBS = HAS_POOL ? [...F.libs, 'cheerox-pool'] : F.libs;
// speed/memory charts name the execution model so every comparison is explicit
const SPEED_NAMES = { ...NAME, cheerox: 'cheerox · extractAll', cheerio: 'cheerio · worker pool', parse5: 'parse5 · worker pool', jsdom: 'jsdom · worker pool' };
const BAR_H = 164 + F.libs.length * 52 + 110, SPEED_H = 164 + SPEED_LIBS.length * 52 + 110;
const series = (l) => (l === 'cheerox-pool' ? F.scalingPool.cheerox : F.scaling[l]);
const at = (l, c) => series(l).find((r) => r.cores === c);
const byDesc = (f, libs = F.libs) => [...libs].map((l) => ({ lib: l, v: f(l) })).filter((r) => r.v != null).sort((a, b) => b.v - a.v);
const byAsc = (f, libs = F.libs) => byDesc(f, libs).reverse();

// 1. overview: speed on 1 CPU + speed on 16 CPUs
fs.writeFileSync(`${outDir}/overview-v4.svg`, frame(1344, SPEED_H, 'cheerox vs spec-compliant Node HTML parsers · same extraction job',
  bars(56, 120, 620, { title: 'Pages per second, 1 CPU', sub: 'parse + extract · higher is better', rows: byDesc((l) => at(l, 1).pagesPerSec, SPEED_LIBS), fmt: n0, names: SPEED_NAMES, labelW: 220 }) +
  bars(700, 120, 620, { title: 'Pages per second, 16 CPUs', sub: 'parse + extract · higher is better', rows: byDesc((l) => at(l, 16).pagesPerSec, SPEED_LIBS), fmt: n0, names: SPEED_NAMES, labelW: 220 }),
  [STAMP, 'Title, meta description, a[href], h1–h3 text and image count per page. CPU budget enforced with taskset. "worker pool" = N worker_threads running the sync API; "extractAll" = cheerox\'s native batch API.']));

// 2. memory: working memory at 16 CPUs + retained per MB HTML
fs.writeFileSync(`${outDir}/memory-v4.svg`, frame(1344, SPEED_H, 'Memory footprint',
  bars(56, 120, 620, { title: 'Working memory at 16 CPUs', sub: 'peak RSS minus resident corpus · lower is better', rows: byAsc((l) => at(l, 16).workingMB / 1000, SPEED_LIBS), fmt: (v) => `${n1(v)} GB`, names: SPEED_NAMES, labelW: 220 }) +
  bars(700, 120, 620, { title: 'RSS per MB of HTML kept parsed', sub: '500 live documents · lower is better', rows: byAsc((l) => F.mem[l]?.rssPerHtmlMB), fmt: (v) => `${n1(v)}×` }),
  [STAMP, 'RSS from /proc/self/status. Working memory is VmHWM, reset after the corpus loads, minus RSS with the corpus resident.']));

// 3. scaling: lines, log y
{
  const W = 1344, H = 700, x0 = 140, x1 = 960, y0 = 540, y1 = 120, cores = [1, 2, 4, 8, 16];
  const all = SPEED_LIBS.flatMap((l) => series(l).map((r) => r.pagesPerSec));
  const lo = 10 ** Math.floor(Math.log10(Math.min(...all))), hi = 10 ** Math.ceil(Math.log10(Math.max(...all)));
  const X = (c) => x0 + ((x1 - x0) * Math.log2(c)) / 4;
  const Y = (v) => y0 - ((y0 - y1) * (Math.log10(v) - Math.log10(lo))) / (Math.log10(hi) - Math.log10(lo));
  let s = T(x0, 104, 'Pages per second by CPU budget · log scale · higher is better', { size: 15, fill: INK2 });
  for (let v = lo; v <= hi; v *= 10) s += `<line x1="${x0}" x2="${x1}" y1="${Y(v)}" y2="${Y(v)}" stroke="${GRID}"/>` + T(x0 - 10, Y(v) + 5, v >= 1000 ? `${v / 1000}K` : v, { size: 14, fill: MUTED, anchor: 'end' });
  cores.forEach((c) => (s += T(X(c), y0 + 26, c, { size: 14, fill: MUTED, anchor: 'middle' })));
  s += T((x0 + x1) / 2, y0 + 50, 'CPUs', { size: 14, fill: MUTED, anchor: 'middle' });
  const order = [...SPEED_LIBS].sort((a, b) => a.startsWith('cheerox') - b.startsWith('cheerox'));
  const ends = [];
  for (const l of order) {
    const color = SHADE[l];
    const pts = series(l);
    s += `<polyline fill="none" stroke="${l === 'cheerox-pool' ? BLUE : color}" stroke-width="${l.startsWith('cheerox') ? 3.5 : 2}"${l === 'cheerox-pool' ? ' stroke-dasharray="9 6"' : ''} points="${pts.map((p) => `${X(p.cores)},${Y(p.pagesPerSec)}`).join(' ')}"/>`;
    s += pts.map((p) => `<circle cx="${X(p.cores)}" cy="${Y(p.pagesPerSec)}" r="${l.startsWith('cheerox') ? 5.5 : 4}" fill="${l === 'cheerox-pool' ? BLUE : color}" stroke="#fff" stroke-width="2"/>`).join('');
    ends.push({ l, y: Y(pts.at(-1).pagesPerSec), v: pts.at(-1).pagesPerSec, color });
  }
  ends.sort((a, b) => a.y - b.y); let prev = -1e9;
  for (const e of ends) { e.ly = Math.max(e.y, prev + 24); prev = e.ly; }
  for (const e of ends) {
    if (Math.abs(e.ly - e.y) > 2) s += `<path d="M${x1 + 8},${e.y} L${x1 + 22},${e.ly}" stroke="${MUTED}" fill="none"/>`;
    s += T(x1 + 28, e.ly + 5, `${SPEED_NAMES[e.l]}  ${n0(e.v)}/s`, { size: 15, weight: e.l.startsWith('cheerox') ? 700 : 400, fill: e.l.startsWith('cheerox') ? BLUE : INK });
  }
  fs.writeFileSync(`${outDir}/scaling-v4.svg`, frame(W, H, 'Throughput across CPU budgets', s,
    [STAMP, 'Every thread of the process (main, workers, GC, native pool) shares N CPUs. The dashed line runs cheerox\'s sync API in a worker_threads pool, the same setup as the JS libraries; extractAll is limited by its main thread.']));
}

// 4. correctness: WPT conformance + feature probes
{
  const H5 = F.html5lib.summary, FT = F.features;
  fs.writeFileSync(`${outDir}/correctness-v4.svg`, frame(1344, BAR_H, 'Spec conformance and features',
    bars(56, 120, 620, { title: 'WHATWG tree-construction tests passed', sub: `${n0(F.html5lib.tests)} WPT tests · higher is better`, rows: byDesc((l) => H5[l].strictPct), max: 100, fmt: (v) => `${n1(v)}%` }) +
    bars(700, 120, 620, { title: 'Feature probes passed', sub: `${FT.features.length} executable probes · higher is better`, rows: byDesc((l) => FT.results[l].score), max: FT.features.length, fmt: (v) => `${v} / ${FT.features.length}` }),
    ['web-platform-tests html/syntax/parsing *.dat, whole-document tests · probes run real code against each library (cheerox 1.1.6, cheerio 1.2.0, parse5 8.0.1, jsdom 30.1.3)',
     'No library passes the 83 HTML processing-instruction tests added to WPT in 2026. cheerox output was identical to cheerio on all 3,000 corpus pages.']));
}

// 5. ops on one CPU
{
  const ops = [['parse', 'Parse'], ['extract', 'Parse + extract'], ['serialize', 'Parse + serialize']];
  const max = Math.max(...F.libs.flatMap((l) => ops.map(([o]) => F.ops[l]?.[o]?.mbPerSec ?? 0)));
  let s = '';
  ops.forEach(([o, t], i) => (s += bars(40 + i * 430, 120, 420, { title: t, sub: 'MB of HTML per second · 1 CPU', rows: byDesc((l) => F.ops[l]?.[o]?.mbPerSec), max, fmt: n0, labelW: 140 })));
  fs.writeFileSync(`${outDir}/operations-v4.svg`, frame(1344, BAR_H, 'Single-CPU speed by operation', s, [STAMP, 'Synchronous API on the main thread, pinned to one CPU with taskset. jsdom is absent: one process parsing all 3,000 pages exhausted a 16 GB heap.']));
}

// 6. install footprint
{
  const fp = Object.fromEntries(F.footprint.map((r) => [r.lib, r]));
  const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  let s = bars(40, 120, 420, { title: 'Install size', sub: 'node_modules MB · lower is better', rows: byAsc((l) => fp[l].installBytes / 1e6), fmt: n1, labelW: 140 });
  s += bars(470, 120, 420, { title: 'Packages installed', sub: 'including the library · lower is better', rows: byAsc((l) => fp[l].packages), fmt: n0, labelW: 140 });
  s += bars(900, 120, 420, { title: 'Cold import', sub: 'ms, median of 15 · lower is better', rows: byAsc((l) => med(fp[l].requireMs)), fmt: n1, labelW: 140 });
  fs.writeFileSync(`${outDir}/footprint-v4.svg`, frame(1344, BAR_H, 'Install footprint', s, ['Fresh npm i --omit=dev on Linux x64, Node 24.18.1. cheerox bundles native binaries for 8 platforms (about 5 MB each).']));
}
console.log('ok');
