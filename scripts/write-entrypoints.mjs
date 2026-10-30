/**
 * Installs the root entry points after the tsup build.
 *
 * The published root must behave like cheerio 0.22.0: `require('cheerox')`
 * is the callable `cheerio` module (with `load`, `html`, `xml`, `text`,
 * `parseHTML`, `root`, `contains`, `version` and `fn` as its own
 * properties), while ESM imports get named exports plus the callable
 * default. tsup's namespace bundles cannot express that shape, so this
 * script writes dist/index.{cjs,mjs} and the declaration re-exports from
 * the legacy/modern bundles.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));

const namedLegacy = ['cheerio', 'load', 'html', 'xml', 'text', 'parseHTML', 'root', 'contains'];
const namedModern = ['loadAsync', 'loadAll', 'extractAll', 'configureWorkers', 'workerPoolInfo'];

writeFileSync(dist + 'index.cjs', `'use strict';
const legacy = require('./legacy.cjs');
const modern = require('./modern.cjs');
const cheerio = legacy.cheerio || legacy.default;
// Rusteerio's asynchronous extensions stay available additively.
for (const key of ${JSON.stringify(namedModern)}) {
  if (cheerio[key] === undefined) cheerio[key] = modern[key];
}
module.exports = cheerio;
module.exports.default = cheerio;
module.exports.legacyStatics = legacy.legacyStatics;
`);

writeFileSync(dist + 'index.mjs', `import legacy, {
  ${namedLegacy.join(',\n  ')},
} from './legacy.mjs';
import {
  ${namedModern.join(',\n  ')},
} from './modern.mjs';
export {
  ${[...namedLegacy, ...namedModern].join(',\n  ')},
};
export const legacyStatics = legacy.legacyStatics;
export const version = legacy.version;
export default legacy;
`);

// The declarations re-export the entry's TypeScript surface verbatim.
for (const extension of ['d.ts', 'd.mts']) {
  const source = readFileSync(dist + 'index.' + extension, 'utf8');
  assert.match(source, /\bload\b/, 'index declaration must export the legacy statics');
  assert.match(source, /(export default|as default)/, 'index declaration must export the callable default');
  // No rewrite needed today; the assertion guards the intended shape.
}

// The internal legacy parse module: a callable `parse` with `evaluate` and
// `update` attached, as cheerio 0.22.0's lib/parse.js exposed.
writeFileSync(dist + 'legacy-parse.cjs', `'use strict';
const legacy = require('./legacy.cjs');
module.exports = legacy.parse;
module.exports.evaluate = legacy.evaluate;
module.exports.update = legacy.update;
`);

writeFileSync(dist + 'legacy-parse.mjs', `export { parse as default, evaluate, update, parse } from './legacy.mjs';
`);

writeFileSync(dist + 'legacy-parse.d.ts', `import type { LegacyNode, LegacyOptions } from './legacy.js';
declare function parse(content: string | Buffer, options?: LegacyOptions | null): LegacyNode;
declare namespace parse {
  export function evaluate(content: string | Buffer, options?: LegacyOptions | null): LegacyNode[];
  export function update(arr: unknown, parent: LegacyNode | null): LegacyNode | null;
}
export = parse;
`);

writeFileSync(dist + 'legacy-parse.d.mts', `import type { LegacyNode, LegacyOptions } from './legacy.js';
declare function parse(content: string | Buffer, options?: LegacyOptions | null): LegacyNode;
declare namespace parse {
  export function evaluate(content: string | Buffer, options?: LegacyOptions | null): LegacyNode[];
  export function update(arr: unknown, parent: LegacyNode | null): LegacyNode | null;
}
export default parse;
export { evaluate, update, parse };
`);

console.log('Root entry points installed (callable CommonJS, named-export ESM).');
