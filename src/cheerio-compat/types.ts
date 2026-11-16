import type { CheerioOptions } from '../types.js';

export type LegacyOptions = CheerioOptions & { withDomLvl1?: boolean; normalizeWhitespace?: boolean };

/** A node under the 0.22.0 object model: plain, mutable fields on the views. */
export type LegacyNode = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: LegacyNode[];
  parent?: LegacyNode | null;
  prev?: LegacyNode | null;
  next?: LegacyNode | null;
  root?: LegacyNode | null;
  [key: string]: any;
};

export interface CheerioInstance {
  options: LegacyOptions;
  _root?: CheerioInstance;
  length: number;
  prevObject?: CheerioInstance;
  [index: number]: LegacyNode;
  [Symbol.iterator](): Iterator<LegacyNode>;
  [key: string]: any;
}

export type CheerioConstructor = {
  (selector?: any, context?: any, root?: any, options?: LegacyOptions): CheerioInstance;
  new (selector?: any, context?: any, root?: any, options?: LegacyOptions): CheerioInstance;
  prototype: CheerioPrototype;
};

export type CheerioPrototype = Record<string, any>;

/**
 * cheerio 1.x-compatible type aliases, so code written against rc.12
 * type-imports (`CheerioAPI`, `Cheerio<Element>`, `Element`) keeps
 * compiling against the 0.22 facade unchanged.
 */
export type CheerioAPI = CheerioStatic;
export type Cheerio<T = LegacyNode> = CheerioInstance;
export type Element = LegacyNode;
export type AnyNode = LegacyNode;
export type Document = LegacyNode;
/**
 * A loaded `$`: the callable initialize function with the static methods,
 * the stored root and options, and `fn` for plugins — as in 0.22.0.
 */
export type CheerioStatic = CheerioConstructor & {
  load(content: string | Buffer | ArrayLike<LegacyNode> | LegacyNode, options?: LegacyOptions | null): CheerioStatic;
  html(dom?: any, options?: LegacyOptions): string;
  xml(dom?: any): string;
  text(elems?: ArrayLike<LegacyNode>): string;
  parseHTML(data?: string | null, context?: unknown, keepScripts?: boolean): LegacyNode[] | null;
  root(): CheerioInstance;
  contains(container?: LegacyNode, contained?: LegacyNode): boolean;
  version: string;
  _root: LegacyNode;
  _options: LegacyOptions;
  fn: CheerioPrototype;
  prototype: CheerioPrototype;
};
