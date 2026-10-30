/**
 * The Cheerio 0.22.0 facade, backed by the Rust engine.
 *
 * Every public behavior is ported from cheerio@0.22.0 (commit
 * 49b477e7fe98b74f61f77acd06a0ef4edb5c333e): lib/cheerio.js, lib/static.js,
 * lib/parse.js, lib/utils.js and lib/api/*.js. DOM storage, parsing and
 * selection stay in the native arena; this file supplies the legacy object
 * model (plain field semantics, `root` references, 0.22.0 serialization and
 * css-select 1.2.0 selection semantics) on top of it.
 *
 * Structural rule: sibling and parent links are owned by the engine. All
 * tree surgery installs whole child lists (see writeChildren), which rebuilds
 * the links exactly as 0.22.0's raw `prev`/`next`/`parent` writes did
 * observably; raw pointer writes on attached nodes would fight the engine's
 * own invariants.
 */
import { requireNative, type NativeDocument } from './native.js';
import { getNode, importNodes, nodeBinding, operation, rootNode, viewId, viewIdIn } from './nodes.js';
import { routeDocument } from './router.js';
import { cleanParserOptions } from './hooks.js';
import type { CheerioOptions } from './types.js';
import { version as packageVersion } from '../package.json';

type LegacyOptions = CheerioOptions & { withDomLvl1?: boolean; normalizeWhitespace?: boolean };

/** Cheerio.prototype.options — the exact 0.22.0 defaults. */
const defaultOpts: LegacyOptions = {
  withDomLvl1: true,
  normalizeWhitespace: false,
  xmlMode: false,
  decodeEntities: true,
};

/** lodash.defaults semantics: fill undefined keys from the sources. */
function defaults<T extends object>(target: T, ...sources: (object | undefined | null)[]): T {
  for (const source of sources) {
    if (!source) continue;
    for (const key of Object.keys(source)) {
      const value = (source as Record<string, unknown>)[key];
      if ((target as Record<string, unknown>)[key] === undefined && value !== undefined) {
        (target as Record<string, unknown>)[key] = value;
      }
    }
  }
  return target;
}

/** A node under the 0.22.0 object model: plain, mutable fields on the views. */
type LegacyNode = {
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

interface CheerioInstance {
  options: LegacyOptions;
  _root?: CheerioInstance;
  length: number;
  prevObject?: CheerioInstance;
  [index: number]: LegacyNode;
  [key: string]: any;
}

type CheerioConstructor = {
  (selector?: any, context?: any, root?: any, options?: LegacyOptions): CheerioInstance;
  new (selector?: any, context?: any, root?: any, options?: LegacyOptions): CheerioInstance;
  prototype: CheerioPrototype;
};

type CheerioPrototype = Record<string, any>;

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

const isTag = (elem: unknown): boolean => {
  const type = typeof elem === 'object' && elem !== null ? (elem as { type?: string }).type : elem;
  return (type !== undefined && (tags as Record<string, boolean>)[type as string]) || false;
};
const tags: Record<string, boolean> = { tag: true, script: true, style: true };

const camelCase = (str: string): string => str.replace(/[_.-](\w|$)/g, (_, x: string) => x.toUpperCase());
const cssCase = (str: string): string => str.replace(/[A-Z]/g, '-$&').toLowerCase();

const domEach = <T, C = unknown>(cheerio: { length: number; [index: number]: T }, fn: (this: C, i: number, el: T) => unknown): typeof cheerio => {
  let i = 0;
  const len = cheerio.length;
  while (i < len && fn.call(cheerio as unknown as C, i, cheerio[i]) !== false) ++i;
  return cheerio;
};

/** Create a deep copy by rendering and re-parsing, as 0.22.0 does. */
function cloneDom(dom: LegacyNode[], options: LegacyOptions): LegacyNode[] {
  return evaluate(renderWith(options, dom), options);
}

const quickExpr = /^(?:[^#<]*(<[\w\W]+>)[^>]*$|#([\w\-]*)$)/;

const isHtml = (str: string): boolean => {
  if (str.charAt(0) === '<' && str.charAt(str.length - 1) === '>' && str.length >= 3) return true;
  const match = quickExpr.exec(str);
  return !!(match && match[1]);
};

/*
 * parse.js
 */

/** Legacy options with the native parser mode folded in. */
function legacyOptions(options?: LegacyOptions | null): LegacyOptions {
  return defaults({ ...(options ?? {}) } as LegacyOptions, defaultOpts, { _useHtmlParser2: true, _legacyDom: true });
}

function newDocument(options: LegacyOptions): NativeDocument {
  return routeDocument(new (requireNative().NativeDocument)('', false, JSON.stringify(cleanParserOptions(options))), options);
}

/** As nodes under the legacy model: views that read like plain objects. */
function asNodes(document: NativeDocument, ids: number[]): LegacyNode[] {
  return ids.map((id) => getNode(document, id) as LegacyNode);
}

/**
 * htmlparser2 3.9.1's `normalizeWhitespace`: collapse whitespace runs in
 * regular text nodes to single spaces (script/style contents stay raw).
 */
function normalizeWhitespace(nodes: LegacyNode[]): void {
  for (const node of nodes) {
    if (node.type === 'text') {
      if (/\s\s|\s$|^\s/.test(node.data ?? '')) node.data = (node.data ?? '').replace(/\s+/g, ' ');
    } else if (node.type !== 'script' && node.type !== 'style' && node.children) {
      normalizeWhitespace(node.children);
    }
  }
}

/** htmlparser.parseDOM(content, options): the parsed children, without a root wrapper. */
export function evaluate(content: string | Buffer | ArrayLike<LegacyNode> | LegacyNode, options?: LegacyOptions | null): LegacyNode[] {
  const opts = legacyOptions(options);
  if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
    // A pre-parsed DOM passes through, as in 0.22.0's parse.evaluate: the
    // nodes are imported once and keep their object identities.
    const document = newDocument(opts);
    const nodes = Array.isArray(content) || (content && typeof content === 'object' && 'length' in (content as object))
      ? Array.from(content as ArrayLike<LegacyNode>)
      : [content as LegacyNode];
    return asNodes(document, importNodes(document, nodes));
  }
  const document = routeDocument(
    new (requireNative().NativeDocument)(Buffer.isBuffer(content) ? content.toString() : content, false, JSON.stringify(cleanParserOptions(opts))),
    opts,
  );
  const root = rootNode(document, document.rootId());
  const children = Array.from((root as LegacyNode).children ?? []) as LegacyNode[];
  if (opts.normalizeWhitespace) normalizeWhitespace(children);
  return children;
}

/** One native write that installs a parent's child list and sibling links. */
function writeChildren(parent: LegacyNode, list: LegacyNode[]): void {
  const binding = bindingOf(parent);
  if (!binding) return;
  operation(binding.document, 'setNode', { id: binding.id, field: 'children', value: importNodes(binding.document, list) });
}

/**
 * Update the dom structure for one changed layer — lib/parse.js `update`.
 * The new level is installed with one children write per changed parent;
 * the engine rebuilds the `prev`/`next`/`parent` links.
 */
export function update(arrInput: unknown, parent: LegacyNode | null): LegacyNode | null {
  const arr: LegacyNode[] = Array.isArray(arrInput) ? (arrInput as LegacyNode[]) : [arrInput as LegacyNode];
  // Capture the previous parents before the install re-parents the nodes.
  const oldParents = arr.map((node) => node.parent || node.root);
  if (parent) {
    writeChildren(parent, arr);
  }
  for (let i = 0; i < arr.length; i++) {
    const node = arr[i];
    const oldParent = oldParents[i];
    // 0.22.0 installs `arr` on `parent` first, so members of the new list
    // skip the removal pass by the `oldSiblings !== arr` identity check.
    if (oldParent && oldParent !== parent) {
      const list = Array.from(oldParent.children ?? []);
      const index = list.indexOf(node);
      if (index >= 0) writeChildren(oldParent, list.filter((item, at) => at !== index));
    }
    if (parent && parent.type === 'root') {
      node.root = parent;
    } else {
      node.root = null;
    }
  }
  return parent;
}

/** lib/parse.js: parse into a fresh document and return its `<root>` node. */
export function parse(content: string | Buffer | ArrayLike<LegacyNode> | LegacyNode, options?: LegacyOptions | null): LegacyNode {
  const opts = legacyOptions(options);
  let root: LegacyNode;
  if (typeof content === 'string' || Buffer.isBuffer(content)) {
    const document = routeDocument(
      new (requireNative().NativeDocument)(Buffer.isBuffer(content) ? content.toString() : content, false, JSON.stringify(cleanParserOptions(opts))),
      opts,
    );
    root = rootNode(document, document.rootId()) as LegacyNode;
  } else {
    // A pre-parsed DOM: 0.22.0 wraps it in the synthetic root via update().
    const document = newDocument(opts);
    const nodes = Array.isArray(content) || (content && typeof content === 'object' && 'length' in (content as object))
      ? Array.from(content as ArrayLike<LegacyNode>)
      : [content as LegacyNode];
    root = rootNode(document, document.rootId()) as LegacyNode;
    writeChildren(root, nodes);
  }
  const children = Array.from(root.children ?? []) as LegacyNode[];
  if (opts.normalizeWhitespace) normalizeWhitespace(children);
  for (const child of children) {
    (child as LegacyNode).root = root;
  }
  return root;
}

/*
 * dom-serializer 0.1.0, over node views.
 */

const unencodedElements: Record<string, boolean | undefined> = { style: true, script: true, xmp: true, iframe: true, noembed: true, noframes: true, plaintext: true, noscript: true };

const singleTag: Record<string, boolean | undefined> = {
  area: true, base: true, basefont: true, br: true, col: true, command: true, embed: true, frame: true,
  hr: true, img: true, input: true, isindex: true, keygen: true, link: true, meta: true, param: true,
  source: true, track: true, wbr: true,
};

const xmlReplacements: Record<string, string> = { '&': '&amp;', "'": '&apos;', '>': '&gt;', '<': '&lt;', '"': '&quot;' };
const encodeXmlRegex = /[&'><"]/g;
const nonAsciiRegex = /[^\0-\x7F]/g;
const astralRegex = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

function codePointReplacement(c: string): string {
  return `&#x${c.codePointAt(0)!.toString(16).toUpperCase()};`;
}

/** entities 1.1 `encodeXML`: the five XML characters plus every non-ASCII rune. */
function encodeXML(data: string): string {
  return data
    .replace(encodeXmlRegex, (c) => xmlReplacements[c])
    .replace(astralRegex, codePointReplacement)
    .replace(nonAsciiRegex, codePointReplacement);
}

function formatAttrs(attribs: Record<string, string> | undefined, opts: LegacyOptions): string {
  if (!attribs) return '';
  let output = '';
  for (const key of Object.keys(attribs)) {
    const value = attribs[key];
    if (output) output += ' ';
    output += key;
    if ((value !== null && value !== '') || opts.xmlMode) {
      output += `="${opts.decodeEntities ? encodeXML(value) : value}"`;
    }
  }
  return output;
}

function renderWith(opts: LegacyOptions, dom: unknown, parentName?: string): string {
  let output = '';
  const nodes = Array.isArray(dom) || (dom && typeof dom === 'object' && 'length' in (dom as object))
    ? Array.from(dom as ArrayLike<LegacyNode>)
    : [dom as LegacyNode];
  for (const elem of nodes) {
    if (!elem || !elem.type) continue;
    if (elem.type === 'root') output += renderWith(opts, elem.children);
    else if (isTag(elem)) output += renderTag(elem, opts);
    else if (elem.type === 'directive') output += `<${elem.data}>`;
    else if (elem.type === 'comment') output += `<!--${elem.data}-->`;
    else if (elem.type === 'cdata') output += `<![CDATA[${elem.children && elem.children[0] ? elem.children[0].data : ''}]]>`;
    else output += renderText(elem, opts, parentName);
  }
  return output;
}

function renderTag(elem: LegacyNode, opts: LegacyOptions): string {
  // Handle SVG as in 0.22.0: it renders like XML.
  const effective = elem.name === 'svg' ? ({ decodeEntities: opts.decodeEntities, xmlMode: true } as LegacyOptions) : opts;
  let tag = `<${elem.name}`;
  const attribs = formatAttrs(elem.attribs, effective);
  if (attribs) tag += ` ${attribs}`;
  if (effective.xmlMode && (!elem.children || elem.children.length === 0)) {
    tag += '/>';
  } else {
    tag += '>';
    if (elem.children) tag += renderWith(effective, elem.children, elem.name);
    if (!singleTag[elem.name as string] || effective.xmlMode) tag += `</${elem.name}>`;
  }
  return tag;
}

function renderText(elem: LegacyNode, opts: LegacyOptions, parentName?: string): string {
  let data = elem.data || '';
  if (opts.decodeEntities && !(parentName !== undefined && parentName in unencodedElements)) {
    data = encodeXML(data);
  }
  return data;
}

/*
 * css-select 1.2.0 scoped selection, over native matching.
 */

function bindingOf(node: unknown): { document: NativeDocument; id: number } | undefined {
  return node && typeof node === 'object' ? nodeBinding(node) : undefined;
}

function idsOf(document: NativeDocument, nodes: ArrayLike<unknown>): number[] {
  return importNodes(document, nodes as unknown[]);
}

/**
 * css-select 1.2 `select(query, elems, options)`: candidates are the members
 * of `elems` and their descendants, in list order (domutils.findAll, with
 * removeSubsets applied). A candidate matches when it satisfies the selector
 * and is a context node or a descendant of one — the absolutized `:scope`
 * descendant rule, whose `acceptSelf` branch lets a context node match itself.
 */
function scopedSelect(selector: string, elems: LegacyNode[], options: LegacyOptions): LegacyNode[] {
  if (!selector || !elems.length) return [];
  const document = bindingOf(elems[0])?.document;
  if (!document) return [];
  const context = (options.context as LegacyNode[] | undefined) ?? elems;
  const contextIds = new Set(idsOf(document, context));
  // domutils.removeSubsets: drop members that contain other members.
  const roots = elems.filter((node, index) => !elems.some((other, otherIndex) => otherIndex !== index && isAncestorOf(other, node)));
  const candidates: number[] = [];
  const seen = new Set<number>();
  for (const root of roots) {
    const rootId = viewIdIn(document, root)!;
    if (!seen.has(rootId)) { seen.add(rootId); candidates.push(rootId); }
    for (const id of document.select('*', [rootId])) {
      if (!seen.has(id)) { seen.add(id); candidates.push(id); }
    }
  }
  // css-select 1.2 absolutizes a leading combinator to `:scope >|+|~ ...`:
  // the anchor sits at the context, one relation away from the candidate.
  const leading = /^\s*([>+~])\s*/.exec(selector);
  let rest = selector;
  let combinator: string | undefined;
  if (leading) {
    combinator = leading[1];
    rest = selector.slice(leading[0].length);
  }
  const matched = new Set(matchesSelector(document, candidates, rest, options));
  const result: LegacyNode[] = [];
  for (const id of candidates) {
    if (!matched.has(id)) continue;
    const node = getNode(document, id) as LegacyNode;
    if (combinator && !combinatorAnchored(node, combinator, contextIds)) continue;
    if (!combinator && !withinContext(node, contextIds)) continue;
    result.push(node);
  }
  return result;
}

/**
 * The `:scope` anchor of a leading-combinator selector: the candidate's
 * parent, previous element sibling, or any earlier element sibling must be a
 * context node.
 */
function combinatorAnchored(node: LegacyNode, combinator: string, contextIds: Set<number>): boolean {
  if (combinator === '>') {
    const parent = node.parent;
    return parent !== null && parent !== undefined && contextIds.has(viewId(parent) ?? NaN);
  }
  if (combinator === '+') {
    let sibling = node.prev as LegacyNode | null | undefined;
    while (sibling && !isTag(sibling)) sibling = sibling.prev as LegacyNode | null | undefined;
    return sibling !== null && sibling !== undefined && contextIds.has(viewId(sibling) ?? NaN);
  }
  // '~'
  let sibling = node.prev as LegacyNode | null | undefined;
  while (sibling) {
    if (isTag(sibling) && contextIds.has(viewId(sibling) ?? NaN)) return true;
    sibling = sibling.prev as LegacyNode | null | undefined;
  }
  return false;
}

/**
 * The pseudo-classes css-select 1.2.0 (Cheerio 0.22.0's selector engine)
 * understands; anything else throws, exactly as the original library did.
 */
const legacyPseudos = new Set([
  // filters
  'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type',
  'first-child', 'last-child', 'first-of-type', 'last-of-type',
  'only-of-type', 'only-child',
  // pseudos and jQuery extensions of the time
  'empty', 'link', 'visited', 'selected', 'disabled', 'enabled', 'checked',
  'required', 'optional', 'parent', 'header', 'button', 'input', 'text',
  'contains', 'icontains', 'checkbox', 'file', 'password', 'radio', 'reset',
  'image', 'submit', 'root', 'not', 'has', 'matches', 'scope',
]);

/** Reject pseudo-classes that only exist in later Cheerio lines. */
function validateLegacySelector(selector: string): void {
  let depth = 0;
  let quote = '';
  let escape = false;
  for (let i = 0; i < selector.length; i++) {
    const character = selector[i];
    if (escape) { escape = false; continue; }
    if (character === '\\') { escape = true; continue; }
    if (quote) { if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '[') { depth++; continue; }
    if (character === ']') { depth = Math.max(0, depth - 1); continue; }
    if (depth || character !== ':') continue;
    const match = /^:([a-zA-Z][a-zA-Z0-9-]*)/.exec(selector.slice(i));
    if (!match) continue;
    if (!legacyPseudos.has(match[1])) {
      throw new SyntaxError(`unmatched pseudo-class ${match[0]}`);
    }
    // Skip a balanced argument so nested selectors are not scanned twice.
    if (selector[i + match[0].length] === '(') {
      let parens = 0;
      let innerQuote = '';
      for (let j = i + match[0].length; j < selector.length; j++) {
        const inner = selector[j];
        if (innerQuote) { if (inner === innerQuote) innerQuote = ''; continue; }
        if (inner === '"' || inner === "'") { innerQuote = inner; continue; }
        if (inner === '(') parens++;
        else if (inner === ')') { parens--; if (!parens) { i = j; break; } }
      }
    } else {
      i += match[0].length;
    }
  }
}

/** Native matching for a batch of ids, with 0.22.0's SyntaxError behavior. */
function matchesSelector(document: NativeDocument, ids: number[], selector: string, options: LegacyOptions): number[] {
  validateLegacySelector(selector);
  try {
    return operation<number[]>(document, 'matches', { ids, selector, options: { xmlMode: options.xmlMode } }) ?? [];
  } catch (error) {
    throw error instanceof SyntaxError ? error : new SyntaxError((error as Error)?.message ?? String(error));
  }
}

/** Whether the node or one of its ancestors belongs to the context set. */
function withinContext(node: LegacyNode, contextIds: Set<number>): boolean {
  for (let current: LegacyNode | null = node; current; ) {
    const id = viewId(current);
    if (id !== undefined && contextIds.has(id)) return true;
    const parent: LegacyNode | null | undefined = current.parent;
    if (parent === null || parent === current) {
      // Top-level nodes carry their document root in `.root` (0.22.0 model).
      const root = current.root as LegacyNode | null | undefined;
      return root !== null && root !== undefined && contextIds.has(viewId(root) ?? NaN);
    }
    current = parent!;
  }
  return false;
}

function isAncestorOf(ancestor: LegacyNode, node: LegacyNode | null | undefined): boolean {
  if (node === ancestor) return false;
  for (let current = node?.parent; current; current = current.parent) {
    if (current === ancestor) return true;
    if (current.parent === current) break;
  }
  return false;
}

/** htmlparser2 DomUtils.uniqueSort over views: document order, deduplicated. */
function uniqueSort(nodes: LegacyNode[]): LegacyNode[] {
  const grouped = new Map<NativeDocument, { id: number; node: LegacyNode }[]>();
  for (const node of nodes) {
    const binding = bindingOf(node);
    if (!binding) continue;
    let list = grouped.get(binding.document);
    if (!list) grouped.set(binding.document, list = []);
    list.push({ id: binding.id, node });
  }
  const sorted: LegacyNode[] = [];
  for (const [document, list] of grouped) {
    const order = operation<number[]>(document, 'uniqueSort', { ids: list.map((entry) => entry.id) });
    for (const id of order ?? []) {
      const entry = list.find((candidate) => candidate.id === id);
      if (entry) sorted.push(entry.node);
    }
  }
  return sorted;
}

/*
 * lib/cheerio.js
 */

const isNode = (obj: unknown): boolean => {
  const node = obj as LegacyNode;
  return !!(obj && typeof obj === 'object' && (node.name || node.type === 'text' || node.type === 'comment'));
};

function makeCheerio(): CheerioConstructor {
  const Cheerio = function (this: CheerioInstance, selector?: any, context?: any, root?: any, options?: LegacyOptions) {
    if (!(this instanceof Cheerio)) {
      return new Cheerio(selector, context, root, options);
    }

    this.options = defaults(options || {}, this.options);

    // $(), $(null), $(undefined), $(false)
    if (!selector) return this;

    if (root) {
      if (typeof root === 'string') root = parse(root, this.options);
      this._root = Cheerio.call(this, root);
    }

    // $($)
    if (selector.cheerio) return selector;

    // $(dom)
    if (isNode(selector)) selector = [selector];

    // $([dom])
    if (Array.isArray(selector)) {
      selector.forEach((elem: LegacyNode, idx: number) => {
        this[idx] = elem;
      });
      this.length = selector.length;
      return this;
    }

    // $(<html>)
    if (typeof selector === 'string' && isHtml(selector)) {
      return Cheerio.call(this, (parse(selector, this.options) as LegacyNode).children ?? []);
    }

    // If we don't have a context, maybe we have a root, from loading
    if (!context) {
      context = this._root;
    } else if (typeof context === 'string') {
      if (isHtml(context)) {
        // $('li', '<ul>...</ul>')
        context = Cheerio.call(this, parse(context, this.options));
      } else {
        // $('li', 'ul')
        selector = [context, selector].join(' ');
        context = this._root;
      }
      // $('li', node), $('li', [nodes])
    } else if (!context.cheerio) {
      context = Cheerio.call(this, context);
    }

    // If we still don't have a context, return
    if (!context) return this;

    // #id, .class, tag
    return context.find(selector);
  } as unknown as CheerioStatic;

  Cheerio.prototype.cheerio = '[cheerio object]';
  Cheerio.prototype.options = defaultOpts;
  Cheerio.prototype.length = 0;
  Cheerio.prototype.splice = Array.prototype.splice;

  Cheerio.prototype._make = function (this: CheerioInstance, dom: any, context?: any): CheerioInstance {
    const cheerio = new (this.constructor as CheerioConstructor)(dom, context, this._root, this.options);
    cheerio.prevObject = this;
    return cheerio;
  };

  Cheerio.prototype.toArray = function (this: CheerioInstance): LegacyNode[] {
    return this.get() as LegacyNode[];
  };

  return Cheerio;
}

/*
 * api/attributes.js
 */

const hasOwn = Object.prototype.hasOwnProperty;
const rspace = /\s+/;
const dataAttrPrefix = 'data-';
const primitives: Record<string, unknown> = { null: null, true: true, false: false };
const rboolean = /^(?:autofocus|autoplay|async|checked|controls|defer|disabled|hidden|loop|multiple|open|readonly|required|scoped|selected)$/i;
const rbrace = /^(?:\{[\w\W]*\}|\[[\w\W]*\])$/;

function getAttr(elem: LegacyNode | undefined, name?: string): unknown {
  if (!elem || !isTag(elem)) return;

  if (!elem.attribs) {
    elem.attribs = {};
  }

  // Return the entire attribs object if no attribute specified
  if (!name) {
    return elem.attribs;
  }

  if (hasOwn.call(elem.attribs, name)) {
    // Get the (decoded) attribute
    return rboolean.test(name) ? name : elem.attribs[name];
  }

  // Mimic the DOM and return text content as value for `option's`
  if (elem.name === 'option' && name === 'value') {
    return staticText((elem.children ?? []) as unknown as ArrayLike<LegacyNode>);
  }

  // Mimic DOM with default value for radios/checkboxes
  if (elem.name === 'input' && (elem.attribs.type === 'radio' || elem.attribs.type === 'checkbox') && name === 'value') {
    return 'on';
  }
}

function setAttr(el: LegacyNode, name: string, value: unknown): void {
  if (value === null) {
    removeAttribute(el, name);
  } else {
    el.attribs![name] = value + '';
  }
}

function removeAttribute(elem: LegacyNode, name: string): void {
  if (!elem.attribs || !hasOwn.call(elem.attribs, name)) return;
  delete elem.attribs[name];
}

const splitClass = (className?: string): string[] => (className ? className.trim().split(rspace) : []);

function setDataStore(el: LegacyNode): Record<string, unknown> {
  if (!el.data || typeof el.data !== 'object') (el as any).data = {};
  return (el as any).data;
}

function readData(el: LegacyNode, name?: string): unknown {
  const readAll = arguments.length < 2;
  let domNames: string[], jsNames: string[];

  if (readAll) {
    domNames = Object.keys(el.attribs ?? {}).filter((attrName) => attrName.slice(0, dataAttrPrefix.length) === dataAttrPrefix);
    jsNames = domNames.map((domName) => camelCase(domName.slice(dataAttrPrefix.length)));
  } else {
    domNames = [dataAttrPrefix + cssCase(name!)];
    jsNames = [name!];
  }

  let value: unknown;
  const store = setDataStore(el);
  for (let idx = 0; idx < domNames.length; ++idx) {
    const domName = domNames[idx];
    const jsName = jsNames[idx];
    if (hasOwn.call(el.attribs ?? {}, domName)) {
      value = el.attribs![domName];

      if (hasOwn.call(primitives, value as string)) {
        value = primitives[value as string];
      } else if (value === String(Number(value))) {
        value = Number(value);
      } else if (rbrace.test(value as string)) {
        try {
          value = JSON.parse(value as string);
        } catch { /* keep the string */ }
      }

      store[jsName] = value;
    }
  }

  return readAll ? store : value;
}

const getProp = (el: LegacyNode, name: string): unknown => {
  if (!el || !isTag(el)) return;
  return hasOwn.call(el, name)
    ? (el as any)[name]
    : rboolean.test(name)
      ? getAttr(el, name) !== undefined
      : getAttr(el, name);
};

const setProp = (el: LegacyNode, name: string, value: unknown): void => {
  (el as any)[name] = rboolean.test(name) ? !!value : value;
};

const attributesApi: CheerioPrototype = {
  attr(this: CheerioInstance, name?: any, value?: any) {
    // Set the value (with attr map support)
    if (typeof name === 'object' || value !== undefined) {
      if (typeof value === 'function') {
        return domEach(this, function (i, el) {
          setAttr(el, name, value.call(el, i, el.attribs![name]));
        });
      }
      return domEach(this, function (_i, el) {
        if (!isTag(el)) return;
        if (typeof name === 'object') {
          for (const key of Object.keys(name)) setAttr(el, key, name[key]);
        } else {
          setAttr(el, name, value);
        }
      });
    }

    return getAttr(this[0], name);
  },

  prop(this: CheerioInstance, name?: any, value?: any) {
    if (typeof name === 'string' && value === undefined) {
      switch (name) {
        case 'style': {
          const property = this.css() as Record<string, unknown>;
          let i = 0;
          for (const p of Object.keys(property)) {
            property[i++] = p;
          }
          property.length = i;
          return property;
        }
        case 'tagName':
        case 'nodeName':
          return this[0].name!.toUpperCase();
        default:
          return getProp(this[0], name);
      }
    }

    if (typeof name === 'object' || value !== undefined) {
      if (typeof value === 'function') {
        return domEach(this, function (i, el) {
          setProp(el, name, value.call(el, i, getProp(el, name)));
        });
      }
      return domEach(this, function (_i, el) {
        if (!isTag(el)) return;
        if (typeof name === 'object') {
          for (const key of Object.keys(name)) setProp(el, key, name[key]);
        } else {
          setProp(el, name, value);
        }
      });
    }
  },

  data(this: CheerioInstance, name?: any, value?: any) {
    const elem = this[0] as LegacyNode;

    if (!elem || !isTag(elem)) return;

    // Return the entire data object if no data specified
    if (!name) {
      return readData(elem);
    }

    // Set the value (with attr map support)
    if (typeof name === 'object' || value !== undefined) {
      domEach(this, function (_i, el) {
        const store = setDataStore(el);
        if (typeof name === 'object') Object.assign(store, name);
        else store[name] = value;
      });
      return this;
    } else if (hasOwn.call(setDataStore(elem), name)) {
      return setDataStore(elem)[name];
    }

    return readData(elem, name);
  },

  val(this: CheerioInstance, value?: any) {
    const querying = arguments.length === 0;
    const element = this[0] as LegacyNode;

    if (!element) return;

    switch (element.name) {
      case 'textarea':
        return this.text(value);
      case 'input':
        switch (this.attr('type')) {
          case 'radio':
            if (querying) {
              return this.attr('value');
            } else {
              this.attr('value', value);
              return this;
            }
          default:
            return this.attr('value', value);
        }
      case 'select': {
        const option = this.find('option:selected') as CheerioInstance | undefined;
        let returnValue: unknown;
        if (option === undefined) return undefined;
        if (!querying) {
          if (!(this.attr() as any).hasOwnProperty('multiple') && typeof value === 'object') {
            return this;
          }
          if (typeof value !== 'object') {
            value = [value];
          }
          this.find('option').removeAttr('selected');
          for (let i = 0; i < value.length; i++) {
            this.find(`option[value="${value[i]}"]`).attr('selected', '');
          }
          return this;
        }
        returnValue = option.attr('value');
        if ((this.attr() as any).hasOwnProperty('multiple')) {
          returnValue = [];
          domEach(option, function (_i, el) {
            (returnValue as unknown[]).push(getAttr(el, 'value'));
          });
        }
        return returnValue;
      }
      case 'option':
        if (!querying) {
          this.attr('value', value);
          return this;
        }
        return this.attr('value');
    }
  },

  removeAttr(this: CheerioInstance, name: string) {
    domEach(this, function (_i, elem) {
      removeAttribute(elem, name);
    });
    return this;
  },

  hasClass(this: CheerioInstance, className: string): boolean {
    for (let i = 0; i < this.length; i++) {
      const elem = this[i];
      const attrs = elem.attribs;
      const clazz = attrs && attrs['class'];
      let idx = -1;
      let end: number;

      if (clazz) {
        while ((idx = clazz.indexOf(className, idx + 1)) > -1) {
          end = idx + className.length;
          if ((idx === 0 || rspace.test(clazz[idx - 1])) && (end === clazz.length || rspace.test(clazz[end]))) {
            return true;
          }
        }
      }
    }
    return false;
  },

  addClass(this: CheerioInstance, value?: any) {
    // Support functions
    if (typeof value === 'function') {
      return domEach(this, function (i, el) {
        const className = el.attribs!['class'] || '';
        attributesApi.addClass.call([el] as unknown as CheerioInstance, value.call(el, i, className));
      });
    }

    // Return if no value or not a string or function
    if (!value || typeof value !== 'string') return this;

    const classNames = value.split(rspace);
    const numElements = this.length;

    for (let i = 0; i < numElements; i++) {
      // If selected element isn't a tag, move on
      if (!isTag(this[i])) continue;

      // If we don't already have classes
      const className = getAttr(this[i], 'class') as string | undefined;

      if (!className) {
        setAttr(this[i], 'class', classNames.join(' ').trim());
      } else {
        let setClass = ` ${className} `;
        const numClasses = classNames.length;

        // Check if class already exists
        for (let j = 0; j < numClasses; j++) {
          const appendClass = `${classNames[j]} `;
          if (setClass.indexOf(` ${appendClass}`) < 0) setClass += appendClass;
        }

        setAttr(this[i], 'class', setClass.trim());
      }
    }

    return this;
  },

  removeClass(this: CheerioInstance, value?: any) {
    // Handle if value is a function
    if (typeof value === 'function') {
      return domEach(this, function (i, el) {
        attributesApi.removeClass.call([el] as unknown as CheerioInstance, value.call(el, i, el.attribs!['class'] || ''));
      });
    }

    const classes = splitClass(value);
    const numClasses = classes.length;
    const removeAll = arguments.length === 0;

    return domEach(this, function (_i, el) {
      if (!isTag(el)) return;

      if (removeAll) {
        // Short circuit the remove all case as this is the nice one
        el.attribs!.class = '';
      } else {
        const elClasses = splitClass(el.attribs!.class);
        let changed: boolean | undefined;

        for (let j = 0; j < numClasses; j++) {
          const index = elClasses.indexOf(classes[j]);

          if (index >= 0) {
            elClasses.splice(index, 1);
            changed = true;

            // We have to do another pass to ensure that there are not duplicate
            // classes listed
            j--;
          }
        }
        if (changed) {
          el.attribs!.class = elClasses.join(' ');
        }
      }
    });
  },

  toggleClass(this: CheerioInstance, value?: any, stateVal?: boolean) {
    // Support functions
    if (typeof value === 'function') {
      return domEach(this, function (i, el) {
        attributesApi.toggleClass.call([el] as unknown as CheerioInstance, value.call(el, i, el.attribs!['class'] || '', stateVal), stateVal);
      });
    }

    // Return if no value or not a string or function
    if (!value || typeof value !== 'string') return this;

    const classNames = value.split(rspace);
    const numClasses = classNames.length;
    const state = typeof stateVal === 'boolean' ? (stateVal ? 1 : -1) : 0;
    const numElements = this.length;

    for (let i = 0; i < numElements; i++) {
      // If selected element isn't a tag, move on
      if (!isTag(this[i])) continue;

      const elementClasses = splitClass(this[i].attribs!.class);

      // Check if class already exists
      for (let j = 0; j < numClasses; j++) {
        // Check if the class name is currently defined
        const index = elementClasses.indexOf(classNames[j]);

        // Add if stateValue === true or we are toggling and there is no value
        if (state >= 0 && index < 0) {
          elementClasses.push(classNames[j]);
        } else if (state <= 0 && index >= 0) {
          // Otherwise remove but only if the item exists
          elementClasses.splice(index, 1);
        }
      }

      this[i].attribs!.class = elementClasses.join(' ');
    }

    return this;
  },

  is(this: CheerioInstance, selector?: any): boolean {
    if (selector) {
      return (traversingApi.filter as any).call(this, selector).length > 0;
    }
    return false;
  },
};

/*
 * api/traversing.js
 */

const traversingApi: CheerioPrototype = {
  find(this: CheerioInstance, selectorOrHaystack?: any) {
    const self = this;
    if (selectorOrHaystack && typeof selectorOrHaystack !== 'string') {
      const haystack: LegacyNode[] = selectorOrHaystack.cheerio ? selectorOrHaystack.get() : [selectorOrHaystack];
      const contains = (self.constructor as any).contains;
      return this._make(haystack.filter(function (elem: LegacyNode) {
        for (let idx = 0, len = self.length; idx < len; ++idx) {
          if (contains(self[idx], elem)) return true;
        }
        return false;
      }));
    }

    const elems: LegacyNode[] = [];
    for (let i = 0; i < this.length; i++) {
      for (const child of this[i].children ?? []) if (isTag(child)) elems.push(child);
    }

    const options = { ...this.options, context: this.toArray() } as LegacyOptions;
    return this._make(scopedSelect(selectorOrHaystack, elems, options));
  },

  parent(this: CheerioInstance, selector?: any) {
    const set: LegacyNode[] = [];

    domEach(this, function (_idx, elem) {
      const parentElem = elem.parent;
      if (parentElem && set.indexOf(parentElem) < 0) {
        set.push(parentElem);
      }
    });

    const filtered = arguments.length ? (traversingApi.filter as any).call(set as unknown as CheerioInstance, selector, this) : set;
    return this._make(filtered as LegacyNode[]);
  },

  parents(this: CheerioInstance, selector?: any) {
    const parentNodes: LegacyNode[] = [];

    // When multiple DOM elements are in the original set, the resulting set
    // will be in *reverse* order of the original elements as well, with
    // duplicates removed.
    this.get().reverse().forEach(function (this: CheerioInstance, elem: LegacyNode) {
      traverseParents(this, elem.parent, selector, Infinity).forEach((node) => {
        if (parentNodes.indexOf(node) === -1) {
          parentNodes.push(node);
        }
      });
    }, this);

    return this._make(parentNodes);
  },

  parentsUntil(this: CheerioInstance, selector?: any, filter?: any) {
    const parentNodes: LegacyNode[] = [];
    let untilNode: LegacyNode | undefined;
    let untilNodes: LegacyNode[] | undefined;

    if (typeof selector === 'string') {
      untilNode = scopedSelect(selector, this.parents().toArray() as LegacyNode[], this.options)[0];
    } else if (selector && selector.cheerio) {
      untilNodes = selector.toArray();
    } else if (selector) {
      untilNode = selector;
    }

    this.toArray().reverse().forEach(function (elem: LegacyNode) {
      while ((elem = elem.parent as LegacyNode)) {
        if ((untilNode && elem !== untilNode) ||
          (untilNodes && untilNodes.indexOf(elem) === -1) ||
          (!untilNode && !untilNodes)) {
          if (isTag(elem) && parentNodes.indexOf(elem) === -1) parentNodes.push(elem);
        } else {
          break;
        }
      }
    });

    return this._make((filter ? scopedSelect(filter, parentNodes, this.options) : parentNodes) as LegacyNode[]);
  },

  closest(this: CheerioInstance, selector?: any) {
    const set: LegacyNode[] = [];

    if (!selector) {
      return this._make(set);
    }

    domEach(this, function (this: CheerioInstance, _idx, elem) {
      const closestElem = traverseParents(this, elem, selector, 1)[0];

      // Do not add duplicate elements to the set
      if (closestElem && set.indexOf(closestElem) < 0) {
        set.push(closestElem);
      }
    });

    return this._make(set);
  },

  next(this: CheerioInstance, selector?: any) {
    if (!this[0]) return this;
    const elems: LegacyNode[] = [];

    for (let i = 0; i < this.length; i++) {
      let elem: LegacyNode = this[i];
      while ((elem = elem.next as LegacyNode)) {
        if (isTag(elem)) {
          elems.push(elem);
          break;
        }
      }
    }

    return selector ? (traversingApi.filter as any).call(elems as unknown as CheerioInstance, selector, this) : this._make(elems);
  },

  nextAll(this: CheerioInstance, selector?: any) {
    if (!this[0]) return this;
    const elems: LegacyNode[] = [];

    for (let i = 0; i < this.length; i++) {
      let elem: LegacyNode = this[i];
      while ((elem = elem.next as LegacyNode)) {
        if (isTag(elem) && elems.indexOf(elem) === -1) {
          elems.push(elem);
        }
      }
    }

    return selector ? (traversingApi.filter as any).call(elems as unknown as CheerioInstance, selector, this) : this._make(elems);
  },

  nextUntil(this: CheerioInstance, selector?: any, filterSelector?: any) {
    if (!this[0]) return this;
    const elems: LegacyNode[] = [];
    let untilNode: LegacyNode | undefined;
    let untilNodes: LegacyNode[] | undefined;

    if (typeof selector === 'string') {
      untilNode = scopedSelect(selector, this.nextAll().get() as LegacyNode[], this.options)[0];
    } else if (selector && selector.cheerio) {
      untilNodes = selector.get();
    } else if (selector) {
      untilNode = selector;
    }

    for (let i = 0; i < this.length; i++) {
      let elem: LegacyNode = this[i];
      while ((elem = elem.next as LegacyNode)) {
        if ((untilNode && elem !== untilNode) ||
          (untilNodes && untilNodes.indexOf(elem) === -1) ||
          (!untilNode && !untilNodes)) {
          if (isTag(elem) && elems.indexOf(elem) === -1) {
            elems.push(elem);
          }
        } else {
          break;
        }
      }
    }

    return filterSelector ? (traversingApi.filter as any).call(elems as unknown as CheerioInstance, filterSelector, this) : this._make(elems);
  },

  prev(this: CheerioInstance, selector?: any) {
    if (!this[0]) return this;
    const elems: LegacyNode[] = [];

    for (let i = 0; i < this.length; i++) {
      let elem: LegacyNode = this[i];
      while ((elem = elem.prev as LegacyNode)) {
        if (isTag(elem)) {
          elems.push(elem);
          break;
        }
      }
    }

    return selector ? (traversingApi.filter as any).call(elems as unknown as CheerioInstance, selector, this) : this._make(elems);
  },

  prevAll(this: CheerioInstance, selector?: any) {
    if (!this[0]) return this;
    const elems: LegacyNode[] = [];

    for (let i = 0; i < this.length; i++) {
      let elem: LegacyNode = this[i];
      while ((elem = elem.prev as LegacyNode)) {
        if (isTag(elem) && elems.indexOf(elem) === -1) {
          elems.push(elem);
        }
      }
    }

    return selector ? (traversingApi.filter as any).call(elems as unknown as CheerioInstance, selector, this) : this._make(elems);
  },

  prevUntil(this: CheerioInstance, selector?: any, filterSelector?: any) {
    if (!this[0]) return this;
    const elems: LegacyNode[] = [];
    let untilNode: LegacyNode | undefined;
    let untilNodes: LegacyNode[] | undefined;

    if (typeof selector === 'string') {
      untilNode = scopedSelect(selector, this.prevAll().get() as LegacyNode[], this.options)[0];
    } else if (selector && selector.cheerio) {
      untilNodes = selector.get();
    } else if (selector) {
      untilNode = selector;
    }

    for (let i = 0; i < this.length; i++) {
      let elem: LegacyNode = this[i];
      while ((elem = elem.prev as LegacyNode)) {
        if ((untilNode && elem !== untilNode) ||
          (untilNodes && untilNodes.indexOf(elem) === -1) ||
          (!untilNode && !untilNodes)) {
          if (isTag(elem) && elems.indexOf(elem) === -1) {
            elems.push(elem);
          }
        } else {
          break;
        }
      }
    }

    return filterSelector ? (traversingApi.filter as any).call(elems as unknown as CheerioInstance, filterSelector, this) : this._make(elems);
  },

  siblingsAndMe(this: CheerioInstance) {
    const elems: LegacyNode[] = [];
    const parent = this[0] ? this[0].parent || this[0].root : undefined;
    if (parent) for (const sibling of parent.children ?? []) elems.push(sibling);
    return this._make(elems);
  },

  siblings(this: CheerioInstance, selector?: any) {
    const parent = this.parent() as CheerioInstance;

    const source = parent.length ? parent.children() : this.siblingsAndMe();
    const elems: LegacyNode[] = (source as CheerioInstance).toArray().filter((elem: LegacyNode) => isTag(elem) && !this.is(elem));

    if (selector !== undefined) {
      return (traversingApi.filter as any).call(elems as unknown as CheerioInstance, selector, this);
    } else {
      return this._make(elems);
    }
  },

  children(this: CheerioInstance, selector?: any) {
    const elems: LegacyNode[] = [];
    for (let i = 0; i < this.length; i++) {
      for (const child of this[i].children ?? []) if (isTag(child)) elems.push(child);
    }

    if (selector === undefined) return this._make(elems);

    return (traversingApi.filter as any).call(elems as unknown as CheerioInstance, selector, this);
  },

  contents(this: CheerioInstance) {
    const all: LegacyNode[] = [];
    for (let i = 0; i < this.length; i++) {
      all.push(...(this[i].children ?? []));
    }
    return this._make(all);
  },

  each(this: CheerioInstance, fn: (this: LegacyNode, i: number, el: LegacyNode) => unknown) {
    let i = 0;
    const len = this.length;
    while (i < len && fn.call(this[i], i, this[i]) !== false) ++i;
    return this;
  },

  map(this: CheerioInstance, fn: (this: LegacyNode, i: number, el: LegacyNode) => any) {
    const memo: unknown[] = [];
    for (let i = 0; i < this.length; i++) {
      const el = this[i];
      const val = fn.call(el, i, el);
      if (val != null) {
        if (Array.isArray(val)) memo.push(...val);
        else memo.push(val);
      }
    }
    return this._make(memo as LegacyNode[]);
  },

  filter(this: CheerioInstance, match?: any, container?: CheerioInstance) {
    return makeFilterMethod((list, testFn) => list.filter((el, i) => testFn(el, i))).call(this, match, container);
  },

  not(this: CheerioInstance, match?: any, container?: CheerioInstance) {
    return makeFilterMethod((list, testFn) => list.filter((el, i) => !testFn(el, i))).call(this, match, container);
  },

  has(this: CheerioInstance, selectorOrHaystack?: any) {
    const that = this;
    return traversingApi.filter.call(this, function (this: LegacyNode) {
      return that._make(this).find(selectorOrHaystack).length > 0;
    }) as CheerioInstance;
  },

  first(this: CheerioInstance) {
    return this.length > 1 ? this._make(this[0]) : this;
  },

  last(this: CheerioInstance) {
    return this.length > 1 ? this._make(this[this.length - 1]) : this;
  },

  eq(this: CheerioInstance, i: number) {
    i = +i;

    // Use the first identity optimization if possible
    if (i === 0 && this.length <= 1) return this;

    if (i < 0) i = this.length + i;
    return this[i] ? this._make(this[i]) : this._make([]);
  },

  get(this: CheerioInstance, i?: number) {
    if (i == null) {
      return Array.prototype.slice.call(this);
    } else {
      return this[i < 0 ? this.length + i : i];
    }
  },

  index(this: CheerioInstance, selectorOrNeedle?: any) {
    let $haystack: CheerioInstance, needle: unknown;

    if (arguments.length === 0) {
      $haystack = this.parent().children() as CheerioInstance;
      needle = this[0];
    } else if (typeof selectorOrNeedle === 'string') {
      $haystack = this._make(selectorOrNeedle);
      needle = this[0];
    } else {
      $haystack = this;
      needle = selectorOrNeedle.cheerio ? selectorOrNeedle[0] : selectorOrNeedle;
    }

    return ($haystack.get() as unknown[]).indexOf(needle);
  },

  slice(this: CheerioInstance, ...args: any[]) {
    return this._make((Array.prototype.slice as any).apply(this, args));
  },

  end(this: CheerioInstance) {
    return this.prevObject || this._make([]);
  },

  add(this: CheerioInstance, other?: any, context?: any) {
    const selection = this._make(other, context);
    const merged = uniqueSort(selection.get().concat(this.get()));
    for (let i = 0; i < merged.length; ++i) {
      selection[i] = merged[i];
    }
    selection.length = merged.length;
    return selection;
  },

  addBack(this: CheerioInstance, selector?: any) {
    return this.add(arguments.length ? this.prevObject!.filter(selector) : this.prevObject);
  },
};

function makeFilterMethod(filterFn: (list: LegacyNode[], testFn: (el: LegacyNode, i: number) => boolean) => LegacyNode[]) {
  return function (this: CheerioInstance | ArrayLike<LegacyNode>, match: any, container?: CheerioInstance) {
    let testFn: (el: LegacyNode, i: number) => boolean;
    const self = this as CheerioInstance;
    const list: LegacyNode[] = typeof (this as CheerioInstance).toArray === 'function'
      ? (this as CheerioInstance).toArray()
      : Array.from(this as ArrayLike<LegacyNode>);
    container = container || (typeof (this as CheerioInstance)._make === 'function' ? self : undefined);

    if (typeof match === 'string') {
      const binding = bindingOf(list[0] ?? (container as CheerioInstance | undefined)?.[0]);
      let compiled: Set<number> | undefined;
      testFn = (el: LegacyNode) => {
        if (!binding) return false;
        if (!compiled) {
          const ids = idsOf(binding.document, list);
          compiled = new Set(matchesSelector(binding.document, ids, match, { xmlMode: container?.options?.xmlMode } as LegacyOptions));
        }
        const id = viewId(el);
        return id !== undefined && compiled.has(id);
      };
    } else if (typeof match === 'function') {
      testFn = (el: LegacyNode, i: number) => !!match.call(el, i, el);
    } else if (match.cheerio) {
      testFn = (el: LegacyNode) => match.toArray().includes(el);
    } else {
      testFn = (el: LegacyNode) => match === el;
    }

    if (!container) {
      // 0.22.0 would call `container._make` on the plain list and crash; be
      // more robust and wrap through the module constructor instead.
      const constructor = ((this as any).constructor && (this as any).constructor.prototype?._make ? (this as any).constructor : moduleCheerio) as CheerioConstructor;
      return new constructor(filterFn(list, testFn)) as CheerioInstance;
    }

    return container._make(filterFn(list, testFn));
  };
}

function traverseParents(self: CheerioInstance, elem: LegacyNode | null | undefined, selector: any, limit: number): LegacyNode[] {
  const elems: LegacyNode[] = [];
  while (elem && elems.length < limit) {
    if (!selector || (traversingApi.filter as any).call([elem] as unknown as CheerioInstance, selector, self).length) {
      elems.push(elem);
    }
    elem = elem.parent;
  }
  return elems;
}

/*
 * api/manipulation.js
 */

const manipulationApi: CheerioPrototype = {
  _makeDomArray(this: CheerioInstance, elem: any, clone?: boolean): LegacyNode[] {
    if (elem == null) {
      return [];
    } else if (elem.cheerio) {
      return clone ? cloneDom(elem.get(), elem.options) : elem.get();
    } else if (Array.isArray(elem)) {
      return elem.reduce<LegacyNode[]>((memo, el) => memo.concat(this._makeDomArray(el, clone)), []);
    } else if (typeof elem === 'string') {
      return evaluate(elem, this.options);
    } else {
      return clone ? cloneDom([elem], this.options) : [elem];
    }
  },

  appendTo(this: CheerioInstance, target: any) {
    if (!target.cheerio) {
      target = (this.constructor as CheerioConstructor).call(this.constructor, target, null, this._originalRoot);
    }
    target.append(this);
    return this;
  },

  prependTo(this: CheerioInstance, target: any) {
    if (!target.cheerio) {
      target = (this.constructor as CheerioConstructor).call(this.constructor, target, null, this._originalRoot);
    }
    target.prepend(this);
    return this;
  },

  append(this: CheerioInstance, ...elems: any[]) {
    return insert.call(this, (dom: LegacyNode[], children: LegacyNode[], parent: LegacyNode) => {
      uniqueSplice(children, children.length, 0, dom, parent);
    }, elems);
  },

  prepend(this: CheerioInstance, ...elems: any[]) {
    return insert.call(this, (dom: LegacyNode[], children: LegacyNode[], parent: LegacyNode) => {
      uniqueSplice(children, 0, 0, dom, parent);
    }, elems);
  },

  wrap(this: CheerioInstance, wrapper: any) {
    const wrapperFn = typeof wrapper === 'function' && wrapper;
    const lastIdx = this.length - 1;

    for (let i = 0; i < this.length; i++) {
      const el = this[i];
      const parent = el.parent || el.root;

      if (!parent) {
        continue;
      }
      const siblings = Array.from(parent.children ?? []);

      let currentWrapper = wrapper;
      if (wrapperFn) {
        currentWrapper = wrapperFn.call(el, i);
      }

      if (typeof currentWrapper === 'string' && !isHtml(currentWrapper)) {
        currentWrapper = this.parents().last().find(currentWrapper).clone();
      }

      const dom = this._makeDomArray(currentWrapper, i < lastIdx).slice(0, 1);
      const index = siblings.indexOf(el);

      update([el], dom[0]);
      // The previous operation removed the current element from the
      // `siblings` list, so the `dom` array can be inserted without
      // removing any additional elements.
      siblings.splice(siblings.indexOf(el), 1);
      uniqueSplice(siblings, index, 0, dom, parent);
    }

    return this;
  },

  after(this: CheerioInstance, ...elems: any[]) {
    const lastIdx = this.length - 1;

    domEach(this, function (this: CheerioInstance, i, el) {
      const parent = el.parent || el.root;
      if (!parent) {
        return;
      }

      const siblings = Array.from(parent.children ?? []);
      const index = siblings.indexOf(el);
      let domSrc: any;
      let dom: LegacyNode[];

      // If not found, move on
      if (index < 0) return;

      if (typeof elems[0] === 'function') {
        domSrc = elems[0].call(el, i, staticHtml.call(this, el.children));
      } else {
        domSrc = elems;
      }
      dom = this._makeDomArray(domSrc, i < lastIdx);

      // Add element after `this` element
      uniqueSplice(siblings, index + 1, 0, dom, parent);
    });

    return this;
  },

  insertAfter(this: CheerioInstance, target: any) {
    const self = this;
    if (typeof target === 'string') {
      target = (this.constructor as CheerioConstructor).call(this.constructor, target, null, this._originalRoot);
    }
    const targetNodes = this._makeDomArray(target);
    self.remove();
    const clones: LegacyNode[][] = [];
    domEach(targetNodes as unknown as { length: number; [index: number]: LegacyNode }, function (this: CheerioInstance, _i, el) {
      const clonedSelf = self._makeDomArray(self.clone());
      const parent = el.parent || el.root;
      if (!parent) {
        return;
      }

      const siblings = Array.from(parent.children ?? []);
      const index = siblings.indexOf(el);

      // If not found, move on
      if (index < 0) return;

      // Add cloned `this` element(s) after target element
      uniqueSplice(siblings, index + 1, 0, clonedSelf, parent);
      clones.push(clonedSelf);
    });
    return (this.constructor as CheerioConstructor).call(this.constructor, this._makeDomArray(clones as any)) as CheerioInstance;
  },

  before(this: CheerioInstance, ...elems: any[]) {
    const lastIdx = this.length - 1;

    domEach(this, function (this: CheerioInstance, i, el) {
      const parent = el.parent || el.root;
      if (!parent) {
        return;
      }

      const siblings = Array.from(parent.children ?? []);
      const index = siblings.indexOf(el);
      let domSrc: any;
      let dom: LegacyNode[];

      // If not found, move on
      if (index < 0) return;

      if (typeof elems[0] === 'function') {
        domSrc = elems[0].call(el, i, staticHtml.call(this, el.children));
      } else {
        domSrc = elems;
      }

      dom = this._makeDomArray(domSrc, i < lastIdx);

      // Add element before `el` element
      uniqueSplice(siblings, index, 0, dom, parent);
    });

    return this;
  },

  insertBefore(this: CheerioInstance, target: any) {
    const self = this;
    if (typeof target === 'string') {
      target = (this.constructor as CheerioConstructor).call(this.constructor, target, null, this._originalRoot);
    }
    const targetNodes = this._makeDomArray(target);
    self.remove();
    const clones: LegacyNode[][] = [];
    domEach(targetNodes as unknown as { length: number; [index: number]: LegacyNode }, function (this: CheerioInstance, _i, el) {
      const clonedSelf = self._makeDomArray(self.clone());
      const parent = el.parent || el.root;
      if (!parent) {
        return;
      }

      const siblings = Array.from(parent.children ?? []);
      const index = siblings.indexOf(el);

      // If not found, move on
      if (index < 0) return;

      // Add cloned `this` element(s) after target element
      uniqueSplice(siblings, index, 0, clonedSelf, parent);
      clones.push(clonedSelf);
    });
    return (this.constructor as CheerioConstructor).call(this.constructor, this._makeDomArray(clones as any)) as CheerioInstance;
  },

  remove(this: CheerioInstance, selector?: any) {
    const elems: CheerioInstance = selector ? this.filter(selector) : this;

    domEach(elems, function (_i, el) {
      const parent = el.parent || el.root;
      if (!parent) {
        return;
      }

      const siblings = Array.from(parent.children ?? []);
      const index = siblings.indexOf(el);

      if (index < 0) return;

      writeChildren(parent, siblings.filter((item, at) => at !== index));
      // The rebuild above cleared the arena links; drop the legacy root ref.
      el.root = null;
    });

    return this;
  },

  replaceWith(this: CheerioInstance, content: any) {
    const self = this;

    domEach(this, function (this: CheerioInstance, i, el) {
      const parent = el.parent || el.root;
      if (!parent) {
        return;
      }

      const siblings = Array.from(parent.children ?? []);
      const dom = self._makeDomArray(typeof content === 'function' ? content.call(el, i, el) : content);
      const index = siblings.indexOf(el);

      // In the case that `dom` contains nodes that already exist in other
      // structures, ensure those nodes are properly removed.
      for (const node of dom) update(node, null);

      // Completely remove old element
      uniqueSplice(siblings, index, 1, dom, parent);
      el.root = null;
    });

    return this;
  },

  empty(this: CheerioInstance) {
    domEach(this, function (_i, el) {
      writeChildren(el, []);
    });
    return this;
  },

  html(this: CheerioInstance, str?: any) {
    if (str === undefined) {
      if (!this[0] || !this[0].children) return null;
      return staticHtml.call(this, this[0].children, this.options);
    }

    const opts = this.options;

    domEach(this, function (this: CheerioInstance, _i, el) {
      const content = str.cheerio ? str.clone().get() : evaluate(`${str}`, opts);
      update(content, el);
    });

    return this;
  },

  toString(this: CheerioInstance): string {
    return staticHtml.call(this, this as unknown as LegacyNode[], this.options);
  },

  text(this: CheerioInstance, str?: any) {
    // If `str` is undefined, act as a "getter"
    if (str === undefined) {
      return staticText.call(this, this as unknown as ArrayLike<LegacyNode>);
    } else if (typeof str === 'function') {
      // Function support
      return domEach(this, function (this: CheerioInstance, i, el) {
        const $el = [el] as unknown as CheerioInstance;
        return manipulationApi.text.call($el, str.call(el, i, staticText($el)));
      });
    }

    // Append text node to each selected elements
    domEach(this, function (this: CheerioInstance, _i, el) {
      const document = bindingOf(el)!.document;
      const textId = operation<number>(document, 'createNode', { type: 'text', data: `${str}`, options: legacyOptions(this.options) });
      const elem = getNode(document, textId) as LegacyNode;
      update(elem, el);
    });

    return this;
  },

  clone(this: CheerioInstance) {
    return this._make(cloneDom(this.get(), this.options));
  },
};

function insert(this: CheerioInstance, concatenator: (dom: LegacyNode[], children: LegacyNode[], parent: LegacyNode) => void, elems: any[]) {
  const lastIdx = this.length - 1;

  return domEach(this, function (this: CheerioInstance, i, el) {
    let domSrc: any;
    let dom: LegacyNode[];

    if (typeof elems[0] === 'function') {
      domSrc = elems[0].call(el, i, staticHtml.call(this, el.children));
    } else {
      domSrc = elems;
    }

    dom = this._makeDomArray(domSrc, i < lastIdx);
    concatenator(dom, el.children!, el as LegacyNode);
  });
}

/**
 * Modify an array in-place, removing some number of elements and adding new
 * elements directly following them — lib/api/manipulation.js `uniqueSplice`.
 * Structural changes install whole child lists (see writeChildren); the
 * engine rebuilds the sibling links.
 */
function uniqueSplice(array: LegacyNode[], spliceIdx: number, spliceCount: number, newElems: LegacyNode[], parent: LegacyNode): void {
  const current = Array.from(array);

  // Before splicing in new elements, ensure they do not already appear in the
  // current array.
  for (let idx = 0; idx < newElems.length; ++idx) {
    const node = newElems[idx];
    const oldParent = node.parent || node.root;
    const prevIdx = oldParent ? Array.from(oldParent.children ?? []).indexOf(node) : -1;

    if (oldParent && prevIdx > -1) {
      if (oldParent === parent) {
        // 0.22.0 splices the node out of the same list and compensates the
        // splice index for the shift.
        current.splice(prevIdx, 1);
        if (spliceIdx > prevIdx) spliceIdx--;
      } else {
        writeChildren(oldParent, Array.from(oldParent.children ?? []).filter((item, at) => at !== prevIdx));
      }
    }

    node.root = null;
  }

  const merged = current.slice(0, spliceIdx).concat(newElems, current.slice(spliceIdx + spliceCount));
  writeChildren(parent, merged);
}

/*
 * api/css.js
 */

const cssApi: CheerioPrototype = {
  css(this: CheerioInstance, prop?: any, val?: any) {
    if (arguments.length === 2 || (Object.prototype.toString.call(prop) === '[object Object]')) {
      return domEach(this, function (idx, el) {
        setCss(el, prop, val, idx);
      });
    } else {
      return getCss(this[0], prop);
    }
  },
};

function setCss(el: LegacyNode, prop: any, val: any, idx: number): void {
  if (typeof prop === 'string') {
    const styles = parseStyles(el.attribs?.style);
    if (typeof val === 'function') {
      val = val.call(el, idx, styles[prop]);
    }

    if (val === '') {
      delete styles[prop];
    } else if (val != null) {
      styles[prop] = val;
    }

    el.attribs!.style = stringifyStyles(styles);
  } else if (typeof prop === 'object') {
    for (const key of Object.keys(prop)) {
      setCss(el, key, prop[key], idx);
    }
  }
}

function getCss(el: LegacyNode | undefined, prop?: any): any {
  const styles = parseStyles(el?.attribs?.style);
  if (typeof prop === 'string') {
    return styles[prop];
  } else if (Array.isArray(prop)) {
    return pick(styles, prop);
  } else {
    return styles;
  }
}

function pick(obj: Record<string, string>, props: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const prop of props) if (prop in obj) result[prop] = obj[prop];
  return result;
}

function stringifyStyles(obj: Record<string, string>): string {
  return Object.keys(obj).reduce((str, prop) => `${str}${str ? ' ' : ''}${prop}: ${obj[prop]};`, '');
}

function parseStyles(styles: string | undefined): Record<string, string> {
  styles = (styles || '').trim();

  if (!styles) return {};

  return styles.split(';').reduce<Record<string, string>>((obj, str) => {
    const n = str.indexOf(':');
    // skip if there is no :, or if it is the first/last character
    if (n < 1 || n === str.length - 1) return obj;
    obj[str.slice(0, n).trim()] = str.slice(n + 1).trim();
    return obj;
  }, {});
}

/*
 * api/forms.js
 */

const submittableSelector = 'input,select,textarea,keygen';
const r20 = /%20/g;
const rCRLF = /\r?\n/g;

const formsApi: CheerioPrototype = {
  serialize(this: CheerioInstance): string {
    // Convert form elements into name/value objects
    const arr = formsApi.serializeArray.call(this);

    // Serialize each element into a key/value string
    const retArr = arr.map((data: { name: string; value: string }) => `${encodeURIComponent(data.name)}=${encodeURIComponent(data.value)}`);

    // Return the resulting serialization
    return retArr.join('&').replace(r20, '+');
  },

  serializeArray(this: CheerioInstance): Array<{ name: string; value: string }> {
    // Resolve all form elements from either forms or collections of form elements
    const Cheerio = this.constructor as CheerioConstructor;
    return (this.map(function (this: LegacyNode) {
      const elem = this;
      const $elem = Cheerio(elem);
      if (elem.name === 'form') {
        return ($elem.find(submittableSelector) as CheerioInstance).toArray();
      } else {
        return $elem.filter(submittableSelector).toArray();
      }
    }) as CheerioInstance)
      .filter(
        // Verify elements have a name (`attr.name`) and are not disabled (`:disabled`)
        '[name!=""]:not(:disabled)'
        // and cannot be clicked (`[type=submit]`) or are used in `x-www-form-urlencoded` (`[type=file]`)
        + ':not(:submit, :button, :image, :reset, :file)'
        // and are either checked/don't have a checkable state
        + ':matches([checked], :not(:checkbox, :radio))')
      .map(function (_i: number, elem: LegacyNode) {
        const $elem = Cheerio(elem);
        const name = $elem.attr('name') as string;
        const val = $elem.val();

        // If there is no value set (e.g. `undefined`, `null`), then return nothing
        if (val == null) {
          return null;
        } else {
          // If we have an array of values (e.g. `<select multiple>`), return an array of key/value pairs
          if (Array.isArray(val)) {
            return val.map((value: string) => ({
              name,
              value: value.replace(rCRLF, '\r\n'),
            }));
            // Otherwise (e.g. `<input type="text">`, return only one key/value pair
          } else {
            return { name, value: (val as string).replace(rCRLF, '\r\n') };
          }
        }
      })
      .get() as Array<{ name: string; value: string }>;
  },
};

/*
 * lib/static.js
 */

function render(that: { _root?: CheerioInstance }, dom: any, options: LegacyOptions): string {
  if (!dom) {
    if (that._root && (that._root as unknown as LegacyNode).children) {
      dom = (that._root as unknown as LegacyNode).children;
    } else {
      return '';
    }
  } else if (typeof dom === 'string') {
    const roots = ((that._root ?? {}) as unknown as LegacyNode).children ?? [];
    dom = scopedSelect(dom, roots, { ...options, context: roots });
  }

  return renderWith(options, dom);
}

/** $.html([selector | dom], [options]) */
function staticHtml(this: any, dom?: any, options?: LegacyOptions): string {
  const Cheerio = moduleCheerio;

  // be flexible about parameters, sometimes we call html(),
  // with options as only parameter
  if (Object.prototype.toString.call(dom) === '[object Object]' && !options && !('length' in dom) && !('type' in dom)) {
    options = dom;
    dom = undefined;
  }

  // sometimes $.html() used without preloading html
  // so fallback non existing options to the default ones
  options = defaults(options ?? {}, this._options, Cheerio.prototype.options) as LegacyOptions;

  return render(this, dom, options);
}

/** $.xml([selector | dom]) */
function staticXml(this: any, dom?: any): string {
  const options = defaults({ xmlMode: true } as LegacyOptions, this._options);
  return render(this, dom, options);
}

/** $.text(dom) */
function staticText(this: any, elems?: ArrayLike<LegacyNode>): string {
  if (!elems) {
    elems = staticRoot.call(this) as unknown as ArrayLike<LegacyNode>;
  }
  const list = Array.from(elems ?? []) as LegacyNode[];
  if (list.length) {
    // The native text extraction is the same traversal, one call deep.
    const document = bindingOf(list[0])?.document;
    if (document) {
      const ids = idsOf(document, list);
      if (ids.length) {
        const text = document.text(ids);
        if (typeof text === 'string') return text;
      }
    }
  }
  let ret = '';
  const len = list.length;
  for (let i = 0; i < len; i++) {
    const elem = list[i];
    if (elem.type === 'text') ret += elem.data;
    else if (elem.children && elem.type !== 'comment') {
      ret += staticText(elem.children);
    }
  }
  return ret;
}

/** $.parseHTML(data [, context ] [, keepScripts ]) */
function staticParseHTML(this: { load: typeof load }, data?: string | null, context?: unknown, keepScripts = typeof context === 'boolean' ? context : false): LegacyNode[] | null {
  let parsed: CheerioInstance;

  if (!data || typeof data !== 'string') {
    return null;
  }

  if (typeof context === 'boolean') {
    keepScripts = context as boolean;
  }

  parsed = this.load(data) as unknown as CheerioInstance;
  if (!keepScripts) {
    (parsed as any)('script').remove();
  }

  // The `children` array is used by Cheerio internally to group elements that
  // share the same parents. When nodes created through `parseHTML` are
  // inserted into previously-existing DOM structures, they will be removed
  // from the `children` array. The results of `parseHTML` should remain
  // constant across these operations, so a shallow copy should be returned.
  return (parsed.root()[0] as LegacyNode).children!.slice();
}

/** $.root() */
function staticRoot(this: any): CheerioInstance {
  return (this as unknown as CheerioConstructor)(this._root);
}

/** $.contains(container, contained) */
function staticContains(container?: LegacyNode, contained?: LegacyNode): boolean {
  // According to the jQuery API, an element does not "contain" itself
  if (contained === container) {
    return false;
  }

  // Step up the descendants, stopping when the root element is reached
  // (signaled by `.parent` returning a reference to the same object)
  while (contained && contained !== contained.parent) {
    contained = contained.parent as LegacyNode;
    if (contained === container) {
      return true;
    }
  }

  return false;
}

/** $.load(str) */
function load(content: string | Buffer | ArrayLike<LegacyNode> | LegacyNode, options?: LegacyOptions | null): CheerioStatic {
  const Cheerio = moduleCheerio;

  options = defaults({ ...(options ?? {}) }, Cheerio.prototype.options) as LegacyOptions;

  const root = parse(content as string | Buffer, options);

  const initialize = function (this: CheerioInstance, selector?: any, context?: any, r?: any, opts?: LegacyOptions) {
    if (!(this instanceof initialize)) {
      return new (initialize as unknown as CheerioConstructor)(selector, context, r, opts);
    }
    opts = defaults(opts || {}, options);
    return Cheerio.call(this, selector, context, r || root, opts);
  } as unknown as CheerioStatic;

  // Ensure that selections created by the "loaded" `initialize` function are
  // true Cheerio instances.
  initialize.prototype = Object.create(Cheerio.prototype) as CheerioPrototype;
  initialize.prototype.constructor = initialize;

  // Mimic jQuery's prototype alias for plugin authors.
  (initialize as any).fn = initialize.prototype;

  // Keep a reference to the top-level scope so we can chain methods that
  // implicitly resolve selectors; e.g. $("<span>").(".bar"), which otherwise
  // loses ._root
  initialize.prototype._originalRoot = root;

  // Add in the static methods
  Object.assign(initialize, staticExports);

  // Add in the root
  (initialize as any)._root = root;
  // store options
  (initialize as any)._options = options;

  return initialize;
}

const staticExports = {
  load,
  html: staticHtml,
  xml: staticXml,
  text: staticText,
  parseHTML: staticParseHTML,
  root: staticRoot,
  contains: staticContains,
};

/*
 * Module assembly — the callable 0.22.0 module export.
 */

const moduleCheerio = makeCheerio() as unknown as CheerioStatic;
for (const api of [attributesApi, traversingApi, manipulationApi, cssApi, formsApi]) {
  Object.assign(moduleCheerio.prototype, api);
}
Object.assign(moduleCheerio, staticExports);
moduleCheerio.version = packageVersion;

export default moduleCheerio;
export { moduleCheerio as cheerio, load, staticHtml as html, staticXml as xml, staticText as text, staticParseHTML as parseHTML, staticRoot as root, staticContains as contains };
export { staticExports as legacyStatics };
export type { CheerioInstance, CheerioConstructor, CheerioPrototype, LegacyNode, LegacyOptions };
