import type { AnyNode, CheerioOptions, Element, SerializedField } from './types.js';
import type { Cheerio } from './selection.js';
import type { NativeDocument } from './native.js';
import { getNode, hydrateLocation, importNodes, nodeRecord } from './nodes.js';
import { attributeAt, DOCUMENT, plainSnapshot, recordAt, VIEW_LOCAL, VIEW_SELF, VIEW_STATE, type DocumentState } from './router.js';

export interface StyleProp {
  length: number;
  [key: string]: string | number;
  [index: number]: string;
}

export interface AttributeMethods<T = AnyNode> {
  attr<U extends AnyNode>(this: Cheerio<U>, name: string): string | undefined;
  attr<U extends AnyNode>(this: Cheerio<U>): Record<string, string> | undefined;
  attr<U extends AnyNode>(this: Cheerio<U>, name: string, value?: string | null | ((this: Element, index: number, value: string) => string | null)): Cheerio<U>;
  attr<U extends AnyNode>(this: Cheerio<U>, values: Record<string, string | null>): Cheerio<U>;
  prop<U extends AnyNode>(this: Cheerio<U>, name: 'tagName' | 'nodeName'): string | undefined;
  prop<U extends AnyNode>(this: Cheerio<U>, name: 'innerHTML' | 'outerHTML' | 'innerText' | 'textContent'): string | null;
  prop<U extends AnyNode>(this: Cheerio<U>, name: 'style'): StyleProp | undefined;
  prop<U extends AnyNode>(this: Cheerio<U>, name: 'href' | 'src'): string | undefined;
  prop<U extends AnyNode, K extends keyof Element>(this: Cheerio<U>, name: K): Element[K];
  prop<U extends AnyNode, K extends keyof Element>(this: Cheerio<U>, name: K, value: Element[K] | ((this: Element, index: number, property: K) => Element[keyof Element])): Cheerio<U>;
  prop<U extends AnyNode>(this: Cheerio<U>, values: Record<string, string | Element[keyof Element] | boolean>): Cheerio<U>;
  prop<U extends AnyNode>(this: Cheerio<U>, name: string, value: string | boolean | null | ((this: Element, index: number, property: string) => string | boolean)): Cheerio<U>;
  prop<U extends AnyNode>(this: Cheerio<U>, name: string): string;
  data<U extends AnyNode>(this: Cheerio<U>, name: string): unknown;
  data<U extends AnyNode>(this: Cheerio<U>): Record<string, unknown>;
  data<U extends AnyNode>(this: Cheerio<U>, name: string, value: unknown): Cheerio<U>;
  data<U extends AnyNode>(this: Cheerio<U>, values: Record<string, unknown>): Cheerio<U>;
  val<U extends AnyNode>(this: Cheerio<U>): string | string[] | undefined;
  val<U extends AnyNode>(this: Cheerio<U>, value: string | string[]): Cheerio<U>;
  removeAttr<U extends AnyNode>(this: Cheerio<U>, name: string): Cheerio<U>;
  hasClass<U extends AnyNode>(this: Cheerio<U>, name: string): boolean;
  addClass<U extends AnyNode, R extends ArrayLike<U>>(this: R, name?: string | ((this: Element, index: number, current: string) => string | undefined)): R;
  removeClass<U extends AnyNode, R extends ArrayLike<U>>(this: R, name?: string | ((this: Element, index: number, current: string) => string | undefined)): R;
  toggleClass<U extends AnyNode, R extends ArrayLike<U>>(this: R, name?: string | ((this: Element, index: number, current: string, state?: boolean) => string), state?: boolean): R;
  css<U extends AnyNode>(this: Cheerio<U>, names?: string[]): Record<string, string> | undefined;
  css<U extends AnyNode>(this: Cheerio<U>, name: string): string | undefined;
  css<U extends AnyNode>(this: Cheerio<U>, name: string, value: string | ((this: Element, index: number, current: string) => string | undefined)): Cheerio<U>;
  css<U extends AnyNode>(this: Cheerio<U>, values: Record<string, string>): Cheerio<U>;
  serializeArray<U extends AnyNode>(this: Cheerio<U>): SerializedField[];
  serialize<U extends AnyNode>(this: Cheerio<U>): string;
}

type Selection = Cheerio<AnyNode>;
type DataRecord = Record<string, unknown>;
type DataDocument = NativeDocument & {
  retainNodeData?: (id: number, data: DataRecord) => void;
  nodeData?: (id: number) => DataRecord | undefined;
  nodeDataOperation?: (id: number) => (command: string, args: unknown) => unknown;
};

const elementTypes = new Set(['tag', 'script', 'style']);
/** Boolean attributes read as their name in HTML, matched case-insensitively as Cheerio does. */
const booleanAttribute = /^(?:autofocus|autoplay|async|checked|controls|defer|disabled|hidden|loop|multiple|open|readonly|required|scoped|selected)$/i;

const absent = Symbol('absent');
const deferred = Symbol('deferred');

/**
 * Reads an attribute of the selection's first node, as Cheerio reads it from
 * `this[0]`, from cached records; `deferred` leaves the read to the native
 * `attr` operation and `absent` means there is no such attribute.
 */
function readAttribute(selection: Selection, name: string): string | typeof absent | typeof deferred {
  const node = selection[0] as unknown as Record<string | symbol, unknown> | null | undefined;
  if (typeof node !== 'object' || node === null) return absent;
  const state = node[VIEW_STATE] as DocumentState | undefined;
  if (state === undefined || node[VIEW_SELF] !== node) return typeof node.type === 'string' ? deferred : absent;
  const local = node[VIEW_LOCAL] as number;
  const snapshot = plainSnapshot(state, local);
  const record = snapshot ? undefined : recordAt(state, local);
  const type = snapshot ? snapshot.typeOf(local) : record?.type;
  if (type === undefined || !elementTypes.has(type)) return absent;
  const value = attributeAt(state, local, name);
  if (value === undefined) {
    // Snapshot attributes are all strings; a record may hold another value, which the native read interprets.
    const attributes = record?.attribs as Record<string, unknown> | undefined;
    if (attributes && Object.hasOwn(attributes, name)) return deferred;
    return name === 'value' ? deferred : absent;
  }
  const options = selection.options ?? {};
  const isXml = options.xmlMode ?? (options.xml === true || (typeof options.xml === 'object' && options.xml !== null));
  return !isXml && booleanAttribute.test(name) ? name : value;
}

/** Writes one attribute through the routed document's typed path when it has one. */
function setAttribute(selection: Selection, ids: number[], name: string, value: string | null): void {
  const document = selection[DOCUMENT] as NativeDocument & { setAttribute?(ids: number[], name: string, value: string | null): void };
  if (document.setAttribute) document.setAttribute(ids, name, value);
  else selection.op('attr', { ids, name, value });
}

function isElement(selection: Selection, id: number): boolean {
  return ['tag', 'script', 'style'].includes(nodeRecord(selection[DOCUMENT], id)?.type);
}

function nativeValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(value, (_key, value: unknown) => {
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || value === undefined) return { __opaqueJavaScriptValue: true };
    if (typeof value === 'number' && !Number.isFinite(value)) return { __nativeNumber: String(value) };
    if (value && typeof value === 'object') {
      if (seen.has(value)) return { __opaqueJavaScriptValue: true };
      seen.add(value);
    }
    return value;
  });
  return json === undefined ? { __opaqueJavaScriptValue: true } : JSON.parse(json);
}

function hydrateValue(value: any): any {
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && typeof value.__nativeNumber === 'string') return Number(value.__nativeNumber);
    for (const key of Object.keys(value)) value[key] = hydrateValue(value[key]);
  }
  return value;
}

function dataObject(selection: Selection, id: number): Record<string, unknown> {
  // The router stores data per node and carries it along when a node moves
  // between documents, preserving data identities and callback references.
  const document = selection[DOCUMENT] as DataDocument;
  let data = document.nodeData?.(id);
  if (!data) {
    const dispatch = document.nodeDataOperation?.(id) ?? ((command: string, args: unknown) => JSON.parse(document.op(command, JSON.stringify(args))));
    const target: Record<string, unknown> = {};
    data = new Proxy(target, {
      set(object, name, value) {
        Reflect.set(object, name, value);
        if (typeof name === 'string') dispatch('data', { ids: [id], name, value: nativeValue(value) });
        return true;
      },
      defineProperty(object, name, descriptor) {
        Reflect.defineProperty(object, name, descriptor);
        if (typeof name === 'string' && 'value' in descriptor) dispatch('data', { ids: [id], name, value: nativeValue(descriptor.value) });
        return true;
      },
      deleteProperty(object, name) {
        Reflect.deleteProperty(object, name);
        if (typeof name === 'string') dispatch('removeData', { ids: [id], name });
        return true;
      },
    });
    document.retainNodeData?.(id, data);
  }
  const node = getNode(selection[DOCUMENT], id);
  // JS data can contain callbacks, cycles, and object identities. The DOM and
  // parsed data values live in Rust; the node exposes the JS values.
  if (!Object.hasOwn(node, 'data')) {
    const values = data;
    Object.defineProperty(node, 'data', { configurable: true, enumerable: true, get: () => values, set: (value: Record<string, unknown>) => { for (const key of Object.keys(values)) delete values[key]; for (const key of Object.keys(value ?? {})) values[key] = value[key]; } });
  }
  return data;
}

function property(selection: Selection, id: number, name: string, raw = false): any {
  const result = selection.op('prop', { ids: [id], name, ...(raw ? { raw: true } : {}) });
  if (name === 'sourceCodeLocation') return hydrateLocation(result);
  return result?.__nativeNodeProperty ? (getNode(selection[DOCUMENT], id) as any)[result.__nativeNodeProperty] : result === null ? undefined : result;
}

function propertyValue(selection: Selection, name: string, value: any): any {
  if (name === 'children' || name === 'childNodes') return importNodes(selection[DOCUMENT], value);
  if (['parent', 'parentNode', 'prev', 'previousSibling', 'next', 'nextSibling'].includes(name)) return value == null ? null : importNodes(selection[DOCUMENT], [value])[0] ?? null;
  return value;
}

function attr(this: Selection, name?: any, value?: any): any {
  if (typeof name === 'object' || value !== undefined) {
    if (typeof value === 'function') {
      if (typeof name !== 'string') throw new Error('Bad combination of arguments.');
      this.ids.forEach((id, index) => {
        if (!isElement(this, id)) return;
        const node = getNode(this[DOCUMENT], id) as Element;
        const current = node.attribs[name];
        const next = value.call(node, index, current);
        setAttribute(this, [id], name, next === null ? null : String(next));
      });
    } else if (typeof name === 'object') {
      for (const key of Object.keys(name)) setAttribute(this, this.ids, key, name[key] === null ? null : String(name[key]));
    } else {
      setAttribute(this, this.ids, name, value === null ? null : String(value));
    }
    return this;
  }
  if (arguments.length > 1) return this;
  if (typeof name === 'string') {
    const cached = readAttribute(this, name);
    if (cached === absent) return undefined;
    if (cached !== deferred) return cached;
  }
  const result = this.op('attr', { ids: this.ids, ...(typeof name === 'string' ? { name } : {}) });
  if (result === null) return undefined;
  return !name && this.ids.length ? (getNode(this[DOCUMENT], this.ids[0]) as Element).attribs : result;
}

function prop(this: Selection, name: any, value?: any): any {
  if (typeof name === 'string' && value === undefined) return this.ids.length ? property(this, this.ids[0], name) : undefined;
  if (typeof name === 'object' || value !== undefined) {
    if (typeof value === 'function') {
      if (typeof name === 'object') throw new TypeError('Bad combination of arguments.');
      this.ids.forEach((id, index) => {
        if (!isElement(this, id)) return;
        const next = value.call(getNode(this[DOCUMENT], id), index, property(this, id, name, true));
        this.op('prop', { ids: [id], name, value: propertyValue(this, name, next) });
      });
    } else if (typeof name === 'object') {
      for (const key of Object.keys(name)) this.op('prop', { ids: this.ids, name: key, value: propertyValue(this, key, name[key]) });
    } else {
      this.op('prop', { ids: this.ids, name, value: propertyValue(this, name, value) });
    }
    return this;
  }
  return undefined;
}

function data(this: Selection, name?: any, value?: unknown): any {
  const first = this.ids[0];
  if (first === undefined || !isElement(this, first)) return undefined;
  if (name != null && (typeof name === 'object' || value !== undefined)) {
    for (const id of this.ids) {
      if (!isElement(this, id)) continue;
      const record = dataObject(this, id);
      if (typeof name === 'object') for (const key of Object.keys(name)) record[key] = name[key];
      else if (typeof name === 'string') record[name] = value;
    }
    return this;
  }
  const record = dataObject(this, first);
  if (typeof name === 'string' && Object.hasOwn(record, name)) return record[name];
  const found = this.op<{ found: boolean; value?: any }>('data', { ids: [first], ...(name == null ? {} : { name }) });
  if (!found.found) return undefined;
  if (name == null) {
    for (const key of Object.keys(found.value)) if (!Object.hasOwn(record, key)) record[key] = hydrateValue(found.value[key]);
    return record;
  }
  record[name] = hydrateValue(found.value);
  return record[name];
}

function css(this: Selection, name?: any, value?: any): any {
  if (name != null && value != null || typeof name === 'object' && !Array.isArray(name)) {
    if (typeof name === 'object') {
      for (const [propertyIndex, key] of Object.keys(name).entries()) {
        if (typeof name[key] === 'function') {
          for (const id of this.ids) {
            if (!isElement(this, id)) continue;
            const current = this.op('css', { ids: [id], name: key }) ?? undefined;
            const next = name[key].call(getNode(this[DOCUMENT], id), propertyIndex, current);
            this.op('css', { ids: [id], name: key, value: next == null ? null : String(next) });
          }
        } else this.op('css', { ids: this.ids, name: key, value: name[key] == null ? null : String(name[key]) });
      }
    } else if (typeof name === 'string' && typeof value === 'function') {
      this.ids.forEach((id, index) => {
        if (!isElement(this, id)) return;
        const current = this.op('css', { ids: [id], name }) ?? undefined;
        const next = value.call(getNode(this[DOCUMENT], id), index, current);
        this.op('css', { ids: [id], name, value: next == null ? null : String(next) });
      });
    } else if (typeof name === 'string') this.op('css', { ids: this.ids, name, value: value == null ? null : String(value) });
    return this;
  }
  return this.op('css', { ids: this.ids, ...(name === undefined ? {} : { name }) }) ?? undefined;
}

function classMethod(command: 'addClass' | 'removeClass' | 'toggleClass') {
  return function(this: Selection, name?: any, state?: boolean): Selection {
    if (typeof name === 'function') {
      this.ids.forEach((id, index) => {
        if (!isElement(this, id)) return;
        const node = getNode(this[DOCUMENT], id) as Element;
        const next = command === 'toggleClass'
          ? name.call(node, index, node.attribs.class ?? '', state)
          : name.call(node, index, node.attribs.class ?? '');
        if (typeof next === 'string') this.op(command, { ids: [id], name: next, ...(typeof state === 'boolean' ? { state } : {}) });
      });
    } else if (typeof name === 'string' || command === 'removeClass' && arguments.length === 0) {
      this.op(command, { ids: this.ids, ...(typeof name === 'string' ? { name } : { all: true }), ...(typeof state === 'boolean' ? { state } : {}) });
    }
    return this;
  };
}

export function installAttributes(CheerioClass: { prototype: object }): void {
  Object.assign(CheerioClass.prototype, {
    attr, prop, data, css,
    removeAttr(this: Selection, name: string) {
      const ids = this.ids;
      for (const single of String(name).split(/\s+/)) if (single) setAttribute(this, ids, single, null);
      return this;
    },
    hasClass(this: Selection, name: string) { return this.op<boolean>('hasClass', { ids: this.ids, name }); },
    addClass: classMethod('addClass'), removeClass: classMethod('removeClass'), toggleClass: classMethod('toggleClass'),
    val(this: Selection, value?: unknown) {
      if (arguments.length === 0) return this.op('val', { ids: this.ids }) ?? undefined;
      const result = this.op('val', { ids: this.ids, value: value === undefined ? { __undefinedJavaScriptValue: true } : value });
      return result?.chain === false ? result.returnValue : result === false ? undefined : this;
    },
    serializeArray(this: Selection) { return this.op<SerializedField[]>('serializeArray', { ids: this.ids }); },
    serialize(this: Selection) { return this.op<string>('serialize', { ids: this.ids }); },
  });
}
