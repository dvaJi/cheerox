'use strict';
// Fragment-mode tbody check + differential suite coverage probe.
const rc12 = require(process.env.TEMP.replace(/\\/g, '/') + '/rc12-ref/pkg');
const legacy = require('C:/Users/franc/Documents/p-proy/cheerox/dist/index.cjs');

const T = '<table><tr><td>A</td></tr><tr><td>B</td></tr></table>';
const a = rc12.load(T, undefined, false);
const b = legacy.load(T, undefined, false);
console.log('rc.12  fragment: tbody=' + a('tbody').length + ' table>tr=' + a('table > tr').length + ' tbody>tr=' + a('tbody > tr').length);
console.log('cheerox fragment: tbody=' + b('tbody').length + ' table>tr=' + b('table > tr').length + ' tbody>tr=' + b('tbody > tr').length);
