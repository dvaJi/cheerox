import * as nativeDOM from './dom.js';
import { parseNativeDocument, parserOptions, deliverParseErrors, hasParserHooks, cleanParserOptions, createTreeAdapterSession } from './hooks.js';
import { compileExtractPlan, hydrateExtractResult } from './extract-plan.js';
import { extractCooperatively, prepareExtractPlans, releaseExtractPlans, rootExtractPlans } from './extract.js';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { availableParallelism } from 'node:os';
import { requireNative, nativeStatus, type NativeDocument, type NativeQuery } from './native.js';
import { Cheerio } from './selection.js';
import { getNode, importNodes, nodeBinding, operation, rootNode, viewIdIn } from './nodes.js';
import { isHtml } from './utils.js';
import { DOCUMENT, exposeDocumentTo, resumeCollection, routeDocument, sameNodeSpace, usePreparedSnapshot } from './router.js';
import type { AnyNode, Document, CheerioAPI, CheerioOptions, LoadContent, ParallelOptions, ExtractMap, ExtractedMap } from './types.js';

export type * from './types.js';
export type { Cheerio } from './selection.js';
export { nativeStatus };
export const dom = {
  Node: nativeDOM.Node, DataNode: nativeDOM.DataNode, NodeWithChildren: nativeDOM.NodeWithChildren,
  Document: nativeDOM.Document, Element: nativeDOM.Element, Text: nativeDOM.Text,
  Comment: nativeDOM.Comment, ProcessingInstruction: nativeDOM.ProcessingInstruction, CDATA: nativeDOM.CDATA,
  ElementType: nativeDOM.ElementType, isTag: nativeDOM.isTag, isText: nativeDOM.isText,
  isComment: nativeDOM.isComment, isDirective: nativeDOM.isDirective, isDocument: nativeDOM.isDocument,
  isCDATA: nativeDOM.isCDATA, hasChildren: nativeDOM.hasChildren,
} as const;
export { configureWorkers, workerPoolInfo } from './workers.js';
export type { WorkerOptions, WorkerPoolInfo } from './workers.js';
export { loadBuffer, stringStream, decodeStream, fromURL } from './io.js';

const defaultOptions: CheerioOptions = { _useHtmlParser2: false };

/** Cheerio's option merge: without overrides, calls share the base options object. */
export function flattenOptions(options?: CheerioOptions | null, base?: CheerioOptions): CheerioOptions {
  if (!options) return base ?? defaultOptions;
  const result: CheerioOptions = { _useHtmlParser2: false, ...base, ...options };
  if (options?.xml) { result._useHtmlParser2 = true; result.xmlMode = true; if (options.xml !== true) Object.assign(result, options.xml); }
  else if (options?.xmlMode) result._useHtmlParser2 = true;
  return result;
}

/** A synchronous, constructable Cheerio factory backed by a mutable Rust DOM. */
export function createAPI(document: NativeDocument, options?: CheerioOptions | null, initialRoot = document.rootId()): CheerioAPI {
  const internal = flattenOptions(options);
  class LoadedCheerio<T = AnyNode> extends Cheerio<T> {}
  let api: CheerioAPI;
  const createRoot = (rootIds: number[], opts: CheerioOptions): Cheerio<Document> => {
    const rootInstance = new LoadedCheerio<Document>(api, document, rootIds, null, opts);
    rootInstance._root = rootInstance;
    return rootInstance;
  };
  const initialize = function<T = AnyNode>(selector?: any, context?: any, root?: any, override?: CheerioOptions): Cheerio<T> {
    resumeCollection(document);
    if (selector?.cheerio) { exposeDocumentTo(document, selector[DOCUMENT]); return selector; }
    const opts = flattenOptions(override, internal);
    // Each call gets its own root selection, as in Cheerio: callers may change the one `end()` returns.
    const rootInstance = createRoot(root === undefined ? [initialRoot]
        : typeof root === 'string' ? [makeRoot(document, operation(document, 'create', { html: root, options: opts }))]
        : root?.cheerio ? importNodes(document, root.toArray()) : importNodes(document, root), opts);
    if (!selector) return new LoadedCheerio<T>(api, document, [], rootInstance, opts);
    const id = viewIdIn(document, selector);
    if (id !== undefined) return new LoadedCheerio<T>(api, document, [id], rootInstance, opts);
    if (typeof selector === 'string' && isHtml(selector)) return new LoadedCheerio<T>(api, document, operation(document, 'create', { html: selector, options: opts }), rootInstance, opts);
    if (typeof selector === 'object') {
      const values = 'length' in selector && !selector.type ? Array.from(selector as ArrayLike<T>) : [selector];
      const allNodes = values.every((value: any) => value && typeof value === 'object' && typeof value.type === 'string');
      return new LoadedCheerio<T>(api, document, allNodes ? importNodes(document, values) : [], rootInstance, opts, allNodes ? undefined : values);
    }
    if (typeof selector !== 'string') throw new TypeError('Unexpected type of selector');
    let search = selector;
    let searchContext: Cheerio<any> = rootInstance;
    if (context) {
      if (typeof context === 'string') {
        if (isHtml(context)) searchContext = new LoadedCheerio<Document>(api, document, [makeRoot(document, operation(document, 'create', { html: context, options: opts }))], rootInstance, opts);
        else search = `${context} ${search}`;
      } else if (context.cheerio) searchContext = context;
      else searchContext = new LoadedCheerio(api, document, importNodes(document, context), rootInstance, opts);
    }
    return searchContext.find(search) as unknown as Cheerio<T>;
  };
  // As in Cheerio, static methods are shared by every loaded API and read the document through `this`.
  api = Object.assign(initialize, staticMethods, {
    load,
    _root: rootNode(document, initialRoot),
    _options: internal,
    fn: LoadedCheerio.prototype,
    prototype: LoadedCheerio.prototype,
  }) as unknown as CheerioAPI;
  return api;
}

const staticMethods = {
  root(this: CheerioAPI): Cheerio<Document> { return this(this._root) as Cheerio<Document>; },
  html(this: CheerioAPI | undefined, dom?: any, renderOptions?: CheerioOptions): string {
    if (!this) return '';
    if (dom && typeof dom === 'object' && !('length' in dom) && !('type' in dom)) { renderOptions = dom; dom = undefined; }
    const nodes = dom === undefined ? [this._root] : this(dom).toArray();
    const binding = nodeBinding(this._root)!;
    return operation(binding.document, 'render', { ids: importNodes(binding.document, nodes), options: flattenOptions(renderOptions, this._options) });
  },
  xml(this: CheerioAPI, dom?: any): string {
    const binding = nodeBinding(this._root)!;
    return operation(binding.document, 'render', { ids: importNodes(binding.document, dom === undefined ? [this._root] : this(dom).toArray()), options: { ...this._options, xmlMode: true, _useHtmlParser2: true } });
  },
  text(this: CheerioAPI | undefined, elements?: ArrayLike<AnyNode>): string {
    if (!elements && !this) return '';
    const nodes = elements ?? [this!._root];
    const binding = this ? nodeBinding(this._root) : nodeBinding(nodes[0]);
    if (binding) return binding.document.text(importNodes(binding.document, nodes));
    const doc = routeDocument(new (requireNative().NativeDocument)('', false));
    return doc.text(importNodes(doc, nodes));
  },
  parseHTML(this: CheerioAPI, data?: string | null, context?: unknown, keepScripts = typeof context === 'boolean' ? context : false): AnyNode[] | null {
    if (!data || typeof data !== 'string') return null;
    if (typeof context === 'boolean') keepScripts = context;
    const parsed = this.load(data, this._options, false);
    if (!keepScripts) parsed('script').remove();
    return parsed._root.children.slice();
  },
  extract<M extends ExtractMap>(this: CheerioAPI, map: M): ExtractedMap<M> { return this.root().extract(map); },
  contains,
  merge,
};

function makeRoot(document: NativeDocument, children: number[]): number {
  const id = operation<number>(document, 'createNode', { type: 'root' });
  operation(document, 'setNode', { id, field: 'children', value: children });
  return id;
}

export function load(content: LoadContent, options?: CheerioOptions | null, isDocument = true): CheerioAPI {
  if (content == null) throw new Error('cheerio.load() expects a string');
  const opts = flattenOptions(options);
  const binding = requireNative();
  const string = Buffer.isBuffer(content) ? content.toString() : typeof content === 'string' ? content : undefined;
  const document = string === undefined ? routeDocument(new binding.NativeDocument('', false, JSON.stringify(cleanParserOptions(opts))), opts) : parseNativeDocument(string, opts, isDocument);
  if (string !== undefined) return createAPI(document, opts);
  const nodes = importNodes(document, content);
  if (!Array.isArray(content) && (content as AnyNode).type === 'root') return createAPI(document, opts, nodes[0]);
  operation(document, 'setNode', { id: document.rootId(), field: 'children', value: nodes });
  return createAPI(routeDocument(document, opts), opts);
}

export async function loadAsync(content: LoadContent, options?: CheerioOptions | null, isDocument = true): Promise<CheerioAPI> {
  if (content == null) throw new Error('cheerio.load() expects a string');
  if (typeof content !== 'string' && !Buffer.isBuffer(content)) return load(content, options, isDocument);
  const binding = requireNative();
  const opts = flattenOptions(options);
  const html = String(content);
  // User parser hooks execute on JavaScript, exactly where their callbacks live.
  if (!opts._useHtmlParser2 && opts.treeAdapter) {
    const session = createTreeAdapterSession(opts, isDocument);
    try { await session.write(html); return createAPI(await session.end(), opts); }
    catch (error) { session.abort(); throw error; }
  }
  if (opts._useHtmlParser2 && opts.Tokenizer) return createAPI(parseNativeDocument(html, opts, isDocument), opts);
  const document = binding.parseAsync ? await binding.parseAsync(html, isDocument, JSON.stringify(parserOptions(html, opts))) : new binding.NativeDocument(html, isDocument, JSON.stringify(parserOptions(html, opts)));
  deliverParseErrors(document, opts);
  return createAPI(routeDocument(document, opts), opts);
}

export function contains(container: AnyNode, contained: AnyNode): boolean {
  if (!container || !contained || container === contained) return false;
  let parent = nodeBinding(container);
  if (!parent) {
    const document = routeDocument(new (requireNative().NativeDocument)('', false));
    importNodes(document, [container]); parent = nodeBinding(container);
  }
  const child = nodeBinding(contained);
  return !!parent && !!child && sameNodeSpace(child.document, parent.document) && operation(parent.document, 'contains', { container: parent.id, contained: child.id });
}

export function merge<T>(first: ArrayLike<T>, second: ArrayLike<T>): ArrayLike<T> | undefined {
  const arrayLike = (value: any): boolean => Array.isArray(value) || value && typeof value === 'object' && typeof value.length === 'number' && value.length >= 0 && Array.from({ length: value.length }, (_unused, i) => i in value).every(Boolean);
  if (!arrayLike(first) || !arrayLike(second)) return undefined;
  const writable = first as { [key: number]: T; length: number };
  let length = first.length;
  for (let i = 0, count = +second.length; i < count; i++) writable[length++] = second[i];
  writable.length = length;
  return writable;
}

function parallelOptions(options?: ParallelOptions | null): { options: CheerioOptions; threads: number } {
  const { threads = Math.min(availableParallelism(), 256), ...opts } = options ?? {};
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 256) throw new RangeError('threads must be an integer from 1 to 256');
  return { options: flattenOptions(opts), threads };
}

export async function loadAll(content: readonly string[], options?: ParallelOptions | null, isDocument = true): Promise<CheerioAPI[]> {
  return loadAllWithPlans(content, options, isDocument);
}

/**
 * Loads documents in parallel. With `plans`, the parsing threads also run
 * them on each root and build each document's snapshot, which extraction
 * with callbacks would otherwise do on the calling thread when it needs them.
 */
async function loadAllWithPlans(content: readonly string[], options: ParallelOptions | null | undefined, isDocument: boolean, plans?: ReturnType<typeof rootExtractPlans>): Promise<CheerioAPI[]> {
  const { options: opts, threads } = parallelOptions(options);
  if (!Array.isArray(content) || content.some((item) => typeof item !== 'string')) throw new TypeError('loadAll expects an array of HTML strings');
  if (!content.length) return [];
  const binding = requireNative();
  if (!binding.parseManyAsync || hasParserHooks(opts)) return Promise.all(content.map((html) => loadAsync(html, opts, isDocument)));
  const documents = await binding.parseManyAsync([...content], isDocument, threads, JSON.stringify(opts), plans && JSON.stringify(plans));
  return documents.map((document) => {
    const routed = routeDocument(document, opts);
    if (plans) {
      usePreparedSnapshot(routed);
      prepareExtractPlans(routed, plans, document.takePreparedPlans?.());
    }
    return createAPI(routed, opts);
  });
}

function nativeQueries(map: ExtractMap, options: CheerioOptions): NativeQuery[] | undefined {
  const queries: NativeQuery[] = [];
  const plainProperties = /^(?:id|class|title|href|src|alt|name|data-.+|aria-.+)$/;
  for (const key in map) {
    const entry = map[key]; const all = Array.isArray(entry); const descriptor = all ? entry[0] : entry;
    const selector = typeof descriptor === 'string' ? descriptor : descriptor.selector;
    const value = typeof descriptor === 'string' ? 'textContent' : descriptor.value ?? 'textContent';
    if (typeof value !== 'string' || value !== 'textContent' && !plainProperties.test(value) || options.baseURI && (value === 'href' || value === 'src') || options.pseudos) return undefined;
    queries.push({ key, selector, all, ...(value === 'textContent' ? {} : { attr: value }) });
  }
  return queries;
}

export async function extractAll<M extends ExtractMap>(content: readonly string[], map: M, options?: ParallelOptions | null): Promise<ExtractedMap<M>[]> {
  const { options: opts, threads } = parallelOptions(options);
  if (!Array.isArray(content) || content.some((item) => typeof item !== 'string')) throw new TypeError('extractAll expects an array of HTML strings');
  if (!content.length) return [];
  const binding = requireNative();
  const plan = hasParserHooks(opts) ? undefined : compileExtractPlan(map, opts);
  if (binding.extractPlanManyAsync && plan) {
    const results: Record<string, unknown>[] = JSON.parse(await binding.extractPlanManyAsync([...content], JSON.stringify(plan), threads, JSON.stringify(opts)));
    for (const result of results) hydrateExtractResult(result, plan.entries);
    return results as ExtractedMap<M>[];
  }
  const queries = binding.extractPlanManyAsync || hasParserHooks(opts) ? undefined : nativeQueries(map, opts);
  if (binding.extractManyAsync && queries) {
    const results: Record<string, unknown>[] = JSON.parse(await binding.extractManyAsync([...content], queries, threads, true, JSON.stringify(opts)));
    for (const result of results) for (const query of queries) {
      if (!Object.hasOwn(result, query.key)) Object.defineProperty(result, query.key, { value: query.all ? [] : undefined, configurable: true, writable: true, enumerable: true });
      if (query.all && Array.isArray(result[query.key])) result[query.key] = (result[query.key] as unknown[]).filter((value) => value != null);
    }
    return results as ExtractedMap<M>[];
  }
  const documents = await loadAllWithPlans(content, { ...opts, threads }, true, hasParserHooks(opts) ? undefined : rootExtractPlans(map, opts));
  const results: ExtractedMap<M>[] = [];
  let yieldedAt = performance.now();
  for (const document of documents) {
    const root = document.root();
    try { results.push((await extractCooperatively(root, map)).value); } finally { releaseExtractPlans(root[DOCUMENT]); }
    if (performance.now() - yieldedAt >= 4) { await yieldToEventLoop(); yieldedAt = performance.now(); }
  }
  return results;
}
