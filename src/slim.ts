import { load as loadNative, contains, merge } from './modern.js';
import type { CheerioAPI, CheerioOptions, LoadContent } from './types.js';

export { contains, merge };
export { dom } from './modern.js';
export type * from './types.js';
export type { Cheerio } from './selection.js';

/** Parser-compatible slim entry point, backed by the native fragment parser. */
export function load(content: LoadContent, options?: CheerioOptions | null, _isDocument?: boolean): CheerioAPI {
  return loadNative(content, { ...options, _useHtmlParser2: true }, false);
}
