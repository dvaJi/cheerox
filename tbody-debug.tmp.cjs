'use strict';
const legacy = require('C:/Users/franc/Documents/p-proy/cheerox/dist/index.cjs');
const $ = legacy.load('<table><tr><td>A</td></tr><tr><td>B</td></tr></table>');
const dump = (el, depth) => {
  for (const c of el.children ?? []) {
    console.log('  '.repeat(depth) + `[${c.type}] ${c.name ?? ''} data=${JSON.stringify((c.data ?? '').slice(0, 10))}`);
    dump(c, depth + 1);
  }
};
console.log('--- table subtree ---');
dump($('table')[0], 0);
console.log('$("tbody").length =', $('tbody').length);
console.log('$("table > tbody").length =', $('table > tbody').length);
console.log('$("table").find("tbody").length =', $('table').find('tbody').length);
console.log('tbody node via tr parent:', JSON.stringify((() => { const tr = $('tr')[0]; return tr.parent ? { name: tr.parent.name, type: tr.parent.type } : null; })()));
