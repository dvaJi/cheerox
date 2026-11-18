'use strict';
const legacy = require('C:/Users/franc/Documents/p-proy/cheerox/dist/index.cjs');
const SRC = '<div><table><tr><td>A</td></tr><tr><td>B</td></tr></table></div>';
const T = '<table><tr><td>A</td></tr><tr><td>B</td></tr></table>';

// Case 1: two loads, legacy only
const a = legacy.load(SRC);
const b = legacy.load(T);
console.log('two loads  :', a('tbody').length, b('tbody').length);

// Case 2: single load of SRC
const c = legacy.load(SRC);
console.log('single SRC :', c('tbody').length);

// Case 3: single load of T
const d = legacy.load(T);
console.log('single T   :', d('tbody').length);
