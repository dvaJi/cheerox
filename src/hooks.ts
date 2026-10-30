import { requireNative, type NativeDocument } from './native.js';
import { attachParsedNodes, getNode, hydrateLocation, operation } from './nodes.js';
import { plainSnapshot, recordAt, routeDocument, type DocumentState, type RoutedDocument } from './router.js';
import type { CheerioOptions } from './types.js';
import type { TokenizerCallbacks } from './parser-types.js';

const tokenCallbacks = ['onattribdata', 'onattribentity', 'onattribend', 'onattribname', 'oncdata', 'onclosetag', 'oncomment', 'ondeclaration', 'onend', 'onopentagend', 'onopentagname', 'onprocessinginstruction', 'onselfclosingtag', 'ontext', 'ontextentity'] as const;

export function createTokenizerSession(options: CheerioOptions): { write(chunk: string): void; end(): CheerioOptions } {
  const events: unknown[][] = [];
  const callbacks = Object.fromEntries(tokenCallbacks.map((name) => [name, (...args: number[]) => {
    if (name === 'ontextentity' || name === 'onattribentity') {
      const codePoint = +args[0];
      String.fromCodePoint(codePoint);
      args[0] = codePoint;
    }
    events.push([name, ...args]);
  }]));
  const Constructor = options.Tokenizer!;
  const tokenizer = new Constructor(options, callbacks as unknown as TokenizerCallbacks);
  return {
    write(chunk) { if (tokenizer.running) tokenizer.write(chunk); },
    end() { tokenizer.end(); const result = cleanParserOptions(options); result.__tokenEvents = events; return result; },
  };
}

export function cleanParserOptions(options: CheerioOptions): CheerioOptions {
  const result = { ...options };
  delete result.Tokenizer; delete result.treeAdapter; delete result.onParseError;
  delete result.__tokenEvents;
  if (!options._useHtmlParser2 && options.onParseError) { result.__collectParseErrors = true; result.sourceCodeLocationInfo = true; }
  return result;
}

/** User tokenizers run on JavaScript; their actual events are consumed by Rust. */
export function parserOptions(source: string, options: CheerioOptions): CheerioOptions {
  if (options._useHtmlParser2 && options.Tokenizer) {
    const session = createTokenizerSession(options);
    session.write(source);
    return session.end();
  }
  return cleanParserOptions(options);
}

export function deliverParseErrors(document: NativeDocument, options: CheerioOptions): void {
  if (options._useHtmlParser2 || !options.onParseError) return;
  const diagnostics = (document as NativeDocument & { parserDiagnostics?(): string | unknown[] }).parserDiagnostics?.();
  const errors = typeof diagnostics === 'string' ? JSON.parse(diagnostics) : diagnostics ?? [];
  for (const error of errors) options.onParseError(error);
}

export function hasParserHooks(options: CheerioOptions): boolean {
  return !!(options._useHtmlParser2 ? options.Tokenizer : options.treeAdapter || options.onParseError);
}

/** A live tree adapter bridge. Every tree-builder decision consults the user's adapter. */
function treeAdapterBridge(adapter: any, options: CheerioOptions) {
  const deliveredErrors = new Set<string>();
  const nodes: any[] = [];
  const ids = new WeakMap<object, number>();
  const identify = (node: any): number | null => {
    if (node == null) return null;
    if (typeof node !== 'object') throw new TypeError('treeAdapter methods must return DOM node objects');
    let id = ids.get(node);
    if (id === undefined) { id = nodes.length; ids.set(node, id); nodes.push(node); }
    return id;
  };
  const nodeArgs: Record<string, number[]> = {
    appendChild: [0, 1], insertBefore: [0, 1, 2], setTemplateContent: [0, 1], getTemplateContent: [0],
    setDocumentType: [0], setDocumentMode: [0], getDocumentMode: [0], detachNode: [0], insertText: [0],
    insertTextBefore: [0, 2], adoptAttributes: [0], getFirstChild: [0], getChildNodes: [0], getParentNode: [0],
    getAttrList: [0], getTagName: [0], getNamespaceURI: [0], getTextNodeContent: [0], getCommentNodeContent: [0],
    getDocumentTypeNodeName: [0], getDocumentTypeNodePublicId: [0], getDocumentTypeNodeSystemId: [0],
    isTextNode: [0], isCommentNode: [0], isElementNode: [0], isDocumentTypeNode: [0],
    setNodeSourceCodeLocation: [0], getNodeSourceCodeLocation: [0], updateNodeSourceCodeLocation: [0],
    onItemPop: [0, 1], onItemPush: [0],
  };
  const nodeReturns = new Set(['createDocument', 'createDocumentFragment', 'createElement', 'createCommentNode', 'createTextNode', 'getTemplateContent', 'getFirstChild', 'getParentNode']);
  const invoke = (method: string, args: any[]): any => {
    const fn = adapter[method];
    if (typeof fn !== 'function') {
      if (method === 'onItemPop' || method === 'onItemPush') return undefined;
      throw new TypeError(`treeAdapter.${method} must be a function`);
    }
    return Reflect.apply(fn, adapter, args);
  };
  const snapshot = () => {
    const records: any[] = [];
    for (let id = 0; id < nodes.length; id++) {
      const node = nodes[id];
      const element = invoke('isElementNode', [node]);
      const text = invoke('isTextNode', [node]);
      const comment = invoke('isCommentNode', [node]);
      const doctype = invoke('isDocumentTypeNode', [node]);
      const name = element ? invoke('getTagName', [node]) : doctype ? '!doctype' : node.name;
      const type = element ? name === 'script' || name === 'style' ? name : 'tag' : text ? 'text' : comment ? 'comment' : doctype ? 'directive' : node.type ?? 'root';
      const children = element || type === 'root' || type === 'cdata' ? invoke('getChildNodes', [node]) ?? [] : [];
      const record: any = { id, type, children: Array.from(children, identify), parent: identify(invoke('getParentNode', [node])) };
      if (name !== undefined) record.name = name;
      if (element) {
        record.namespace = invoke('getNamespaceURI', [node]);
        record.attribs = Object.create(null); record.attribsNamespace = Object.create(null); record.attribsPrefix = Object.create(null);
        for (const attr of invoke('getAttrList', [node])) {
          Object.defineProperty(record.attribs, attr.name, { value: attr.value, enumerable: true, configurable: true, writable: true });
          record.attribsNamespace[attr.name] = attr.namespace; record.attribsPrefix[attr.name] = attr.prefix;
        }
      } else if (text || comment) record.data = invoke(text ? 'getTextNodeContent' : 'getCommentNodeContent', [node]);
      else if (doctype) {
        record.data = node.data;
        for (const [field, method] of [['x-name', 'getDocumentTypeNodeName'], ['x-publicId', 'getDocumentTypeNodePublicId'], ['x-systemId', 'getDocumentTypeNodeSystemId']]) record[field] = invoke(method, [node]);
      }
      if (type === 'root' && node['x-mode'] !== undefined) record['x-mode'] = invoke('getDocumentMode', [node]);
      for (const field of ['startIndex', 'endIndex', 'sourceCodeLocation']) if (node[field] !== undefined) record[field] = node[field];
      records.push(record);
    }
    return records;
  };
  const bridge = (request: string): string => {
    const { method, args = [] } = JSON.parse(request);
    if (method === '__parseError') {
      deliveredErrors.add(JSON.stringify(args[0]));
      options.onParseError?.(args[0]);
      return 'null';
    }
    if (method === '__snapshot') return JSON.stringify(snapshot());
    if (method === '__locations') {
      for (const entry of args[0]) invoke('setNodeSourceCodeLocation', [nodes[entry.id], hydrateLocation(entry.location)]);
      return 'null';
    }
    const values = args.slice();
    if (method === 'setNodeSourceCodeLocation' || method === 'updateNodeSourceCodeLocation') hydrateLocation(values[1]);
    for (const index of nodeArgs[method] ?? []) values[index] = values[index] == null ? null : nodes[values[index]];
    const result = invoke(method, values);
    return JSON.stringify(method === 'getChildNodes' ? Array.from(result ?? [], identify) : nodeReturns.has(method) ? identify(result) : result ?? null);
  };
  return { bridge, nodes, deliveredErrors };
}

function bindAdapterDocument(document: NativeDocument, options: CheerioOptions, adapter: ReturnType<typeof treeAdapterBridge>): NativeDocument {
  if (options.onParseError) {
    const errors = (document as NativeDocument & { parserDiagnostics?(): string }).parserDiagnostics?.();
    for (const error of errors ? JSON.parse(errors) : []) if (!adapter.deliveredErrors.has(JSON.stringify(error))) options.onParseError(error);
  }
  const routed = routeDocument(document, options);
  const globalId = (routed as NativeDocument & { localNodeId(id: number): number }).localNodeId.bind(routed);
  for (let id = 0; id < adapter.nodes.length; id++) getNode(routed, globalId(id), adapter.nodes[id]);
  return routed;
}

export function createTreeAdapterSession(options: CheerioOptions, isDocument: boolean): { write(chunk: string): Promise<void>; end(): Promise<NativeDocument>; abort(): void } {
  const binding = requireNative() as ReturnType<typeof requireNative> & {
    NativeHookStream?: new (isDocument: boolean, options: string, bridge: (request: string) => string) => { write(chunk: string): Promise<void> | void; finish(): Promise<NativeDocument> | NativeDocument; abort(): void };
  };
  if (!binding.NativeHookStream) throw new Error('This native addon does not support streaming treeAdapter hooks; rebuild the Rust addon.');
  const adapter = treeAdapterBridge(options.treeAdapter, options);
  let hasFailure = false;
  let failure: unknown;
  let aborted = false;
  const bridge = (request: string): string => {
    if (hasFailure || aborted) return '{"__rusteerioHookError":true}';
    try { return adapter.bridge(request); }
    catch (error) { hasFailure = true; failure = error; return '{"__rusteerioHookError":true}'; }
  };
  const parser = new binding.NativeHookStream(isDocument, JSON.stringify(cleanParserOptions(options)), bridge);
  const restoreFailure = (error: unknown): never => { if (hasFailure) throw failure; throw error; };
  return {
    async write(chunk) {
      try { await parser.write(chunk); if (hasFailure) throw failure; }
      catch (error) { restoreFailure(error); }
    },
    async end() {
      try {
        const document = await parser.finish();
        if (hasFailure) throw failure;
        return bindAdapterDocument(document, options, adapter);
      } catch (error) { return restoreFailure(error); }
    },
    abort() { aborted = true; parser.abort(); },
  };
}

export function parseNativeDocument(source: string, options: CheerioOptions, isDocument: boolean): NativeDocument {
  const binding = requireNative();
  const nativeOptions = parserOptions(source, options);
  if (!options._useHtmlParser2 && options.treeAdapter && canReplay(options)) {
    const document = routeDocument(new binding.NativeDocument(source, isDocument, JSON.stringify(nativeOptions)), options) as RoutedDocument;
    const nodes = replayIntoAdapter(document, options.treeAdapter, isDocument);
    if (nodes) { attachParsedNodes(document.state, nodes); return document; }
  }
  if (!options._useHtmlParser2 && options.treeAdapter) {
    const parse = (binding as typeof binding & { parseWithTreeAdapter?(source: string, isDocument: boolean, options: string, bridge: (request: string) => string): NativeDocument }).parseWithTreeAdapter;
    if (!parse) throw new Error('This native addon does not support treeAdapter hooks; rebuild the Rust addon.');
    const adapter = treeAdapterBridge(options.treeAdapter, options);
    return bindAdapterDocument(parse(source, isDocument, JSON.stringify(nativeOptions), adapter.bridge), options, adapter);
  }
  const document = new binding.NativeDocument(source, isDocument, JSON.stringify(nativeOptions));
  deliverParseErrors(document, options);
  return routeDocument(document, options);
}

/** Error-only streams keep the Rust DOM and deliver diagnostics during writes. */
export function createDiagnosticSession(options: CheerioOptions, isDocument = true): { write(chunk: string): Promise<void>; end(): Promise<NativeDocument>; abort(): void } {
  const binding = requireNative() as ReturnType<typeof requireNative> & {
    NativeStream?: new (options: string, isDocument: boolean, bridge: (request: string) => string) => { write(chunk: string): Promise<void>; finish(): Promise<NativeDocument>; abort(): void };
  };
  if (!binding.NativeStream) throw new Error('This native addon does not support incremental parser diagnostics; rebuild the Rust addon.');
  let hasFailure = false;
  let failure: unknown;
  let aborted = false;
  const bridge = (request: string): string => {
    if (hasFailure || aborted) return '{"__rusteerioHookError":true}';
    try {
      const { method, args } = JSON.parse(request);
      if (method === '__parseError') options.onParseError?.(args[0]);
      return 'null';
    } catch (error) { hasFailure = true; failure = error; return '{"__rusteerioHookError":true}'; }
  };
  const parser = new binding.NativeStream(JSON.stringify(cleanParserOptions(options)), isDocument, bridge);
  const restoreFailure = (error: unknown): never => { if (hasFailure) throw failure; throw error; };
  return {
    async write(chunk) { try { await parser.write(chunk); if (hasFailure) throw failure; } catch (error) { restoreFailure(error); } },
    async end() { try { const document = await parser.finish(); if (hasFailure) throw failure; return routeDocument(document, options); } catch (error) { return restoreFailure(error); } },
    abort() { aborted = true; parser.abort(); },
  };
}

/**
 * Whether an adapter can be given the finished tree instead of every parser
 * step: it observes neither the open-element stack nor source locations, and
 * no parse-error callback can change it while parsing.
 */
function canReplay(options: CheerioOptions): boolean {
  const adapter = options.treeAdapter as unknown as Record<string, unknown>;
  return !options.onParseError && !options.sourceCodeLocationInfo && adapter.onItemPush === undefined && adapter.onItemPop === undefined;
}

/**
 * Builds the adapter's tree from a native parse by calling its construction
 * methods in document order, then checks every node against the parse. An
 * adapter whose nodes differ from what it was given (renamed elements,
 * rewritten text, filtered children) could have steered parsing differently,
 * so it returns `undefined` and the caller runs the parser with the adapter
 * live instead.
 */
function replayIntoAdapter(document: RoutedDocument, adapter: any, isDocument: boolean): (object | undefined)[] | undefined {
  const state = document.state;
  const root = document.rootId() - state.base;
  const size = state.baseline;
  const nodes: any[] = new Array(size);
  // Reading every record once builds the snapshot; plain nodes are then read from its arrays.
  for (let local = 0; local < Math.min(size, 65); local++) recordAt(state, local);
  for (let local = 0; local < size; local++) {
    const snapshot = plainSnapshot(state, local);
    const record = snapshot ? undefined : recordAt(state, local);
    if (!snapshot && !record) continue;
    const type = snapshot ? snapshot.typeOf(local) : record!.type;
    if (local === root) {
      nodes[local] = isDocument ? adapter.createDocument() : adapter.createDocumentFragment();
      const mode = record?.['x-mode'];
      if (isDocument && mode !== undefined) adapter.setDocumentMode(nodes[local], mode);
      continue;
    }
    const parentLocal = snapshot ? snapshot.linkOf(local, 1) : record!.parent;
    const parent = parentLocal == null ? undefined : nodes[parentLocal];
    if (parent === undefined) return undefined;
    switch (type) {
      case 'tag': case 'script': case 'style': {
        const element = snapshot
          ? adapter.createElement(snapshot.nameOf(local), snapshot.namespaceOf(local), snapshot.attributeObjects(local))
          : adapter.createElement(record!.name, record!.namespace, attributeList(record));
        adapter.appendChild(parent, element);
        nodes[local] = element;
        break;
      }
      case 'root': {
        const content = adapter.createDocumentFragment();
        adapter.setTemplateContent(parent, content);
        nodes[local] = content;
        break;
      }
      case 'text': {
        adapter.insertText(parent, (snapshot ? snapshot.dataOf(local) : record!.data) ?? '');
        const children = adapter.getChildNodes(parent);
        nodes[local] = children[children.length - 1];
        break;
      }
      case 'comment': {
        const comment = adapter.createCommentNode((snapshot ? snapshot.dataOf(local) : record!.data) ?? '');
        adapter.appendChild(parent, comment);
        nodes[local] = comment;
        break;
      }
      case 'directive': {
        if (!record || record.name !== '!doctype' || !isDocument) return undefined;
        adapter.setDocumentType(parent, record['x-name'] ?? '', record['x-publicId'] ?? '', record['x-systemId'] ?? '');
        nodes[local] = Array.from(adapter.getChildNodes(parent) ?? []).find((child) => adapter.isDocumentTypeNode(child));
        break;
      }
      default: return undefined;
    }
  }
  const changes = differencesFromParse(adapter, nodes, state, root);
  if (!changes) return undefined;
  // Attribute and text rewrites do not steer parsing; the document takes the adapter's values.
  for (const change of changes) operation(document, 'setNode', { id: state.base + change.local, field: change.field, value: change.value });
  return nodes;
}

function attributeList(record: any): { name: string; value: string; namespace?: string; prefix?: string }[] {
  const attributes = record.attribs ?? {};
  return Object.keys(attributes).map((name) => {
    const namespace = record.attribsNamespace?.[name];
    const prefix = record.attribsPrefix?.[name];
    return { name, value: attributes[name], ...(namespace === undefined ? {} : { namespace }), ...(prefix === undefined ? {} : { prefix }) };
  });
}

interface DataChange { local: number; field: 'attribs' | 'attribsNamespace' | 'attribsPrefix' | 'data'; value: unknown }

/**
 * The attribute and text values in which the adapter's nodes differ from the
 * parse, or `undefined` when a name, namespace or link differs, since those
 * could have steered parsing.
 */
function differencesFromParse(adapter: any, nodes: any[], state: DocumentState, root: number): DataChange[] | undefined {
  const changes: DataChange[] = [];
  for (let local = 0; local < nodes.length; local++) {
    const node = nodes[local];
    const snapshot = plainSnapshot(state, local);
    const record = snapshot ? undefined : recordAt(state, local);
    if (!snapshot && !record) continue;
    if (!node) return undefined;
    const type = snapshot ? snapshot.typeOf(local) : record!.type;
    if (local !== root && adapter.getParentNode(node) !== nodes[(snapshot ? snapshot.linkOf(local, 1) : record!.parent)!]) return undefined;
    if (type !== 'text' && type !== 'comment' && type !== 'directive') {
      const children = adapter.getChildNodes(node) ?? [];
      const count = snapshot ? snapshot.childCount(local) : record!.children.length;
      if (children.length !== count) return undefined;
      for (let index = 0; index < count; index++) if (children[index] !== nodes[snapshot ? snapshot.childAt(local, index) : record!.children[index]]) return undefined;
    }
    if (type === 'tag' || type === 'script' || type === 'style') {
      const name = snapshot ? snapshot.nameOf(local) : record!.name;
      const namespace = snapshot ? snapshot.namespaceOf(local) : record!.namespace;
      if (!adapter.isElementNode(node) || adapter.getTagName(node) !== name || adapter.getNamespaceURI(node) !== namespace) return undefined;
      const attributes: { name: string; value: string; namespace?: string; prefix?: string }[] = adapter.getAttrList(node) ?? [];
      const expected = snapshot ? snapshot.attributeObjects(local) : attributeList(record);
      const isSame = attributes.length === expected.length && attributes.every((attribute, index) => attribute.name === expected[index].name && attribute.value === expected[index].value);
      if (!isSame) {
        const values: Record<string, string> = Object.create(null);
        const namespaces: Record<string, string> = Object.create(null);
        const prefixes: Record<string, string> = Object.create(null);
        for (const attribute of attributes) {
          values[attribute.name] = attribute.value;
          if (attribute.namespace !== undefined) namespaces[attribute.name] = attribute.namespace;
          if (attribute.prefix !== undefined) prefixes[attribute.name] = attribute.prefix;
        }
        changes.push({ local, field: 'attribs', value: values }, { local, field: 'attribsNamespace', value: namespaces }, { local, field: 'attribsPrefix', value: prefixes });
      }
    } else if (type === 'text' || type === 'comment') {
      if (type === 'text' ? !adapter.isTextNode(node) : !adapter.isCommentNode(node)) return undefined;
      const data = type === 'text' ? adapter.getTextNodeContent(node) : adapter.getCommentNodeContent(node);
      if (data !== (snapshot ? snapshot.dataOf(local) : record!.data)) changes.push({ local, field: 'data', value: data });
    }
  }
  return changes;
}
