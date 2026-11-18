'use strict';
// Decisive: tbody insertion for tbody-less tables, legacy vs modern facade
// vs rc.12 vs 1.2.0.
const rc12 = require(process.env.TEMP.replace(/\\/g, '/') + '/rc12-ref/pkg');
const v120 = require('C:/Users/franc/Documents/p-proy/cheerox/node_modules/cheerio');
const legacy = require('C:/Users/franc/Documents/p-proy/cheerox/dist/index.cjs');
const modern = require('C:/Users/franc/Documents/p-proy/cheerox/dist/modern.cjs');

const SRC = '<div><table><tr><td>A</td></tr><tr><td>B</td></tr></table></div>';
const T = '<table><tr><td>A</td></tr><tr><td>B</td></tr></table>';

for (const [name, engine, load] of [
  ['rc.12       ', rc12, rc12.load],
  ['1.2.0       ', v120, v120.load],
  ['cheerox leg ', legacy, legacy.load],
  ['cheerox mod ', modern, modern.load],
]) {
  const $ = load(SRC);
  const $t = load(T);
  console.log(
    `${name} tbody=${$('tbody').length} table>tr=${$('table > tr').length} tbody>tr=${$('tbody > tr').length} | bare: tbody=${$t('tbody').length} table>tr=${$t('table > tr').length}`,
  );
}
