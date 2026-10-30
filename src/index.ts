/**
 * The cheerox root entry: the Cheerio 0.22.0-compatible API.
 *
 * The built CommonJS entry point is the callable legacy `cheerio` module
 * itself (scripts/write-entrypoints.mjs installs the wrapper), so calling
 * the required module directly and using its `load` property both work as in
 * the original library. ESM consumers get named exports plus the callable
 * default. Cheerox's modern asynchronous extensions remain available as
 * additive exports; the 1.2.0-style facade itself lives behind the modern
 * entry point.
 */
import legacy from './legacy.js';

export default legacy;

export {
  cheerio,
  load,
  html,
  xml,
  text,
  parseHTML,
  root,
  contains,
  evaluate,
  update,
  parse,
} from './legacy.js';
export type { CheerioInstance, CheerioConstructor, LegacyNode, LegacyOptions } from './legacy.js';

export {
  loadAsync,
  loadAll,
  extractAll,
  configureWorkers,
  workerPoolInfo,
  nativeStatus,
  dom,
  merge,
  flattenOptions,
  createAPI,
  loadBuffer,
  stringStream,
  decodeStream,
  fromURL,
} from './modern.js';

export const version: string = (legacy as unknown as { version: string }).version;
