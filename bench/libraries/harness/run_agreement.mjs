// Output agreement on real pages: does each library extract the same data
// as parse5 (the WHATWG reference implementation in JS)?
// Strings are compared after trimming and collapsing whitespace.
import fs from 'node:fs';
import * as rusteerio from 'rusteerio';
import { LIBS, LIB_NAMES, EXTRACT_MAP } from './libs.mjs';
import { loadCorpus } from './common.mjs';

const pages = loadCorpus();
const norm = (s) => (s === undefined || s === null ? null : String(s).replace(/\s+/g, ' ').trim());
const key = (o) => ({
  title: norm(o.title), desc: norm(o.desc),
  links: o.links.join('\u0000'), headings: o.headings.map(norm).join('\u0000'), imgs: o.imgs,
});
const FIELDS = ['title', 'desc', 'links', 'headings', 'imgs'];

const ref = pages.map((p) => key(LIBS.parse5.extract(p)));
const results = {};
const examples = {};
for (const name of LIB_NAMES) {
  const counts = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  let all = 0, errors = 0;
  examples[name] = [];
  pages.forEach((p, i) => {
    let k;
    try { k = key(LIBS[name].extract(p)); } catch (e) { errors++; return; }
    let ok = true;
    for (const f of FIELDS) {
      if (k[f] === ref[i][f]) counts[f]++;
      else { ok = false; if (examples[name].length < 5) examples[name].push({ page: i, field: f, got: String(k[f]).slice(0, 120), want: String(ref[i][f]).slice(0, 120) }); }
    }
    if (ok) all++;
  });
  results[name] = {
    pagesIdenticalPct: +(100 * all / pages.length).toFixed(2),
    errors,
    fieldPct: Object.fromEntries(FIELDS.map((f) => [f, +(100 * counts[f] / pages.length).toFixed(2)])),
  };
}

// The parallel path must agree with the sync path.
const par = await rusteerio.extractAll(pages, EXTRACT_MAP);
let same = 0;
par.forEach((o, i) => {
  const a = JSON.stringify(key({ ...o, imgs: o.imgs.length }));
  if (a === JSON.stringify(key(LIBS.rusteerio.extract(pages[i])))) same++;
});
results.rusteerio.parallelMatchesSyncPct = +(100 * same / pages.length).toFixed(2);

fs.writeFileSync('results/agreement_examples.json', JSON.stringify(examples, null, 1));
console.log(JSON.stringify({ pages: pages.length, reference: 'parse5', results }));
