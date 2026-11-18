'use strict';
// Real-page findTable with the LOCAL build (normalization included).
const fs = require('fs');
const rc12 = require(process.env.TEMP.replace(/\\/g, '/') + '/rc12-ref/pkg');
const cheerox = require('C:/Users/franc/Documents/p-proy/cheerox/dist/index.cjs');

const html = fs.readFileSync('C:/Users/franc/AppData/Local/Temp/opencode/game8-hsr.html', 'utf8');
const findTable = (Engine) => {
  const $ = Engine.load(html);
  const q = (c) => `body > div.p-archiveBody__container > div.p-archiveBody__main > div.p-archiveContent__container > div.p-archiveContent__main > div.archive-style-wrapper > table:nth-child(${c}) > tbody > tr > td:nth-child(1) > a`;
  let child = 1;
  while (child < 10000) {
    const el = $(q(child));
    if (el && el.length > 10) return { child, hrefs: el.toArray().map((n) => n.attribs.href) };
    child++;
  }
  return { child: null, hrefs: [] };
};
const r = findTable(rc12);
const c = findTable(cheerox);
console.log(`rc.12  : nth-child(${r.child}) -> ${r.hrefs.length} links`);
console.log(`cheerox: nth-child(${c.child}) -> ${c.hrefs.length} links`);
console.log('links identical:', JSON.stringify(r.hrefs) === JSON.stringify(c.hrefs));
