import { LIBS } from './libs.mjs';
import { loadCorpus } from './common.mjs';
const pages = loadCorpus();
let serSame = 0; const serDiff = [];
let same = 0, diffs = [];
pages.forEach((p, i) => {
  const a = JSON.stringify(LIBS.rusteerio.extract(p)), b = JSON.stringify(LIBS.cheerio.extract(p));
  if (a === b) same++; else if (diffs.length < 5) diffs.push(i);
  const sa = LIBS.rusteerio.serialize(p), sb = LIBS.cheerio.serialize(p);
  if (sa === sb) serSame++; else if (serDiff.length < 5) serDiff.push(i);
});

console.log(JSON.stringify({ pages: pages.length, extractIdentical: same, extractIdenticalPct: +(100 * same / pages.length).toFixed(2), diffs, serializeIdentical: serSame, serializeIdenticalPct: +(100 * serSame / pages.length).toFixed(2), serDiff }));
