import type { NativeDocument, NativeNodeRecord } from './native.js';
import { NodeSnapshot } from './snapshot.js';
import type { AnyNode } from './types.js';
import { nodePrototype } from './dom.js';
import { cachedView, cacheView, exposeTo, isLocalState, isRouted, onViewRefresh, plainSnapshot, recordAt, routedFor, stateIn, structureSnapshot, VIEW_ATTRIBUTES, VIEW_CHILD_TARGET, VIEW_LOCAL, VIEW_SELF, VIEW_STATE, type DocumentState } from './router.js';

export interface NodeBinding { document: NativeDocument; id: number }

/** A node object: its fields read the native record for the node's current location. */
interface View { [VIEW_STATE]: DocumentState; [VIEW_LOCAL]: number; [VIEW_SELF]: View; [VIEW_ATTRIBUTES]: AttributeView | undefined; [VIEW_CHILDREN]: AnyNode[] | undefined; [VIEW_CHILD_TARGET]: AnyNode[] | undefined; [key: string]: any }
/** A plain attribute object that mirrors the record; its proxy only intercepts writes. */
/**
 * The handler of a node's attribute proxy, which also keeps the proxy's plain
 * target and the generation it was copied in, so each attribute object costs
 * one target, one handler and one proxy.
 */
interface AttributeView extends ProxyHandler<Record<string, string>> { view: View; proxy: Record<string, string>; target: Record<string, string>; generation: number; state: DocumentState }

const VIEW_CHILDREN = Symbol.for('cheerox.node.children');
const arrayIndex = /^(?:0|[1-9]\d*)$/;
const emptyRecord = Object.freeze({ id: -1, type: 'released', children: [] }) as unknown as NativeNodeRecord;

export function operation<T = any>(document: NativeDocument, command: string, args: unknown = {}): T {
  const direct = (document as NativeDocument & { operate?(command: string, args: unknown): T }).operate;
  if (direct) return direct.call(document, command, args);
  const value = document.op(command, JSON.stringify(args));
  return (value === undefined || value === '' ? undefined : JSON.parse(value)) as T;
}

/** The id of a native node object, without allocating a binding. */
export function viewId(node: unknown): number | undefined {
  const view = node as View | null | undefined;
  const state = view?.[VIEW_STATE];
  return state !== undefined && view![VIEW_SELF] === view && isLocalState(state) ? state.base + view![VIEW_LOCAL] : undefined;
}

/** Whether `node` is a node object of a native document, of this or another copy of the package. */
function isNativeNode(node: unknown): boolean {
  const view = node as View | null | undefined;
  return view?.[VIEW_STATE] !== undefined && view[VIEW_SELF] === view;
}

/** The id of a native node object, made resolvable by `document`'s operations. */
export function viewIdIn(document: NativeDocument, node: unknown): number | undefined {
  const id = viewId(node);
  if (id !== undefined) exposeTo(document, (node as View)[VIEW_STATE]);
  return id;
}

export function nodeBinding(node: unknown): NodeBinding | undefined {
  const id = node && typeof node === 'object' ? viewId(node) : undefined;
  return id === undefined ? undefined : { document: routedFor((node as View)[VIEW_STATE]), id };
}

export function nodeId(node: unknown, document?: NativeDocument): number | undefined {
  const id = node && typeof node === 'object' ? viewId(node) : undefined;
  return id !== undefined && (!document || isRouted(document)) ? id : undefined;
}

/** Recreate parse5's null-prototype attribute maps and shared start-tag map. */
export function hydrateLocation<T>(location: T): T {
  if (!location || typeof location !== 'object') return location;
  const value = location as Record<string, any>;
  if (value.attrs && typeof value.attrs === 'object') Object.setPrototypeOf(value.attrs, null);
  if (value.startTag?.attrs && typeof value.startTag.attrs === 'object') {
    Object.setPrototypeOf(value.startTag.attrs, null);
    if (value.attrs && JSON.stringify(value.attrs) === JSON.stringify(value.startTag.attrs)) value.startTag.attrs = value.attrs;
  }
  return location;
}

/** The node's record; its links are ids local to the node's document. */
export function nodeRecord(document: NativeDocument, id: number): NativeNodeRecord {
  if (!isRouted(document)) return operation(document, 'node', { id });
  const state = stateIn(document, id);
  return recordAt(state, id - state.base) as NativeNodeRecord;
}

const isElementType = (type: string | undefined): boolean => type === 'tag' || type === 'script' || type === 'style';

/** Mirrors the native `traverse` operation over cached records; `undefined` defers to it. */
export function traverseRecords(document: NativeDocument, ids: number[], kind: string): number[] | undefined {
  if (!isRouted(document)) return undefined;
  const result: number[] = [];
  for (const id of ids) {
    const state = stateIn(document, id);
    const { base } = state;
    // Attribute writes leave a snapshot's links and types current, and other
    // writes discard it, so its arrays answer without records.
    const snapshot = state.bulk instanceof NodeSnapshot ? state.bulk : undefined;
    if (snapshot?.isPresent(id - base) && traverseSnapshot(snapshot, base, id - base, kind, result)) continue;
    const node = recordAt(state, id - base);
    if (!node) continue;
    const isElement = (local: number): boolean => isElementType(recordAt(state, local)?.type);
    if (kind === 'children') {
      for (const child of node.children ?? []) if (isElement(child)) result.push(base + child);
    } else if (kind === 'contents') {
      for (const child of node.children ?? []) result.push(base + child);
    } else if (kind === 'parent') {
      if (node.parent != null && isElement(node.parent)) result.push(base + node.parent);
    } else if (kind === 'parents' || kind === 'ancestors') {
      const seen = new Set<number>();
      for (let parent = node.parent; parent != null && !seen.has(parent);) {
        seen.add(parent);
        const ancestor = recordAt(state, parent);
        if (!ancestor || ancestor.type === 'root') break;
        if (isElementType(ancestor.type)) result.push(base + parent);
        parent = ancestor.parent;
      }
    } else if (kind === 'next' || kind === 'prev' || kind === 'nextAll' || kind === 'prevAll') {
      const isForward = kind === 'next' || kind === 'nextAll';
      const isSingle = kind === 'next' || kind === 'prev';
      const seen = new Set<number>();
      for (let sibling = isForward ? node.next : node.prev; sibling != null && !seen.has(sibling);) {
        seen.add(sibling);
        const record = recordAt(state, sibling);
        if (!record) break;
        if (isElementType(record.type)) {
          result.push(base + sibling);
          if (isSingle) break;
        }
        sibling = isForward ? record.next : record.prev;
      }
    } else if (kind === 'siblings') {
      const parent = node.parent == null ? null : recordAt(state, node.parent);
      const local = id - base;
      for (const other of parent?.children ?? []) if (other !== local && isElement(other)) result.push(base + other);
    } else return undefined;
  }
  return result;
}

/** `traverseRecords` for one node of a current snapshot; false for kinds it leaves to records. */
function traverseSnapshot(snapshot: NodeSnapshot, base: number, local: number, kind: string, result: number[]): boolean {
  const pushChildren = (parent: number, isElementsOnly: boolean, except: number): void => {
    const count = snapshot.childCount(parent);
    for (let index = 0; index < count; index++) {
      const child = snapshot.childAt(parent, index);
      if (child !== except && (!isElementsOnly || snapshot.isElementAt(child))) result.push(base + child);
    }
  };
  switch (kind) {
    case 'children': pushChildren(local, true, -1); return true;
    case 'contents': pushChildren(local, false, -1); return true;
    case 'siblings': {
      const parent = snapshot.linkOf(local, 1);
      if (parent !== null && snapshot.isPresent(parent)) pushChildren(parent, true, local);
      return true;
    }
    case 'parent': {
      const parent = snapshot.linkOf(local, 1);
      if (parent !== null && snapshot.isPresent(parent) && snapshot.isElementAt(parent)) result.push(base + parent);
      return true;
    }
    case 'parents': case 'ancestors': {
      let parent = snapshot.linkOf(local, 1);
      for (let steps = 0; parent !== null && steps < snapshot.size && snapshot.isPresent(parent) && !snapshot.isRootAt(parent); steps++) {
        if (snapshot.isElementAt(parent)) result.push(base + parent);
        parent = snapshot.linkOf(parent, 1);
      }
      return true;
    }
    case 'next': case 'prev': case 'nextAll': case 'prevAll': {
      const offset = kind === 'next' || kind === 'nextAll' ? 3 : 2;
      const isSingle = kind === 'next' || kind === 'prev';
      let sibling = snapshot.linkOf(local, offset);
      for (let steps = 0; sibling !== null && steps < snapshot.size && snapshot.isPresent(sibling); steps++) {
        if (snapshot.isElementAt(sibling)) {
          result.push(base + sibling);
          if (isSingle) break;
        }
        sibling = snapshot.linkOf(sibling, offset);
      }
      return true;
    }
    default: return false;
  }
}

/** The node object for an arena slot, created on first use and then shared. */
export function viewAt(state: DocumentState, local: number): AnyNode | undefined {
  const existing = state.views[local] ?? cachedView(state, local);
  if (existing) return existing as AnyNode;
  const parsed = state.adapterNodes?.[local];
  if (parsed) { state.adapterNodes![local] = undefined; return adoptObject(state, local, parsed); }
  const snapshot = structureSnapshot(state, local);
  let constructor: ViewConstructor;
  if (snapshot && !snapshot.hasExtraFields(local)) constructor = viewConstructor(state, snapshot.typeOf(local), false);
  else {
    const record = recordAt(state, local);
    if (!record) return undefined;
    constructor = viewConstructor(state, record.type, record.sourceCodeLocation !== undefined);
  }
  const view = new constructor(state, local);
  cacheView(state, local, view);
  return view as unknown as AnyNode;
}

/** A document root's node object, built without reading its record: its type is known. */
export function rootNode(document: NativeDocument, id: number): AnyNode {
  if (!isRouted(document)) throw new TypeError('Native nodes require a routed document');
  const state = stateIn(document, id);
  const local = id - state.base;
  const existing = cachedView(state, local);
  if (existing) return existing as AnyNode;
  if (state.adapterNodes?.[local] || state.options.sourceCodeLocationInfo) return viewAt(state, local) as AnyNode;
  const view = new (viewConstructor(state, 'root', false))(state, local);
  cacheView(state, local, view);
  return view as unknown as AnyNode;
}

/** Stable DOM node identities; each property reads or updates the Rust arena. */
export function getNode(document: NativeDocument, id: number, original?: any): AnyNode {
  if (!isRouted(document)) throw new TypeError('Native nodes require a routed document');
  const state = stateIn(document, id);
  const local = id - state.base;
  if (original === undefined) return viewAt(state, local) as AnyNode;
  return adoptObject(state, local, original);
}

function viewRecord(view: View): NativeNodeRecord {
  const state = view[VIEW_STATE];
  const local = view[VIEW_LOCAL];
  return state.records[local] ?? recordAt(state, local) ?? emptyRecord;
}

function linkedView(view: View, local: number | null | undefined): AnyNode | null {
  return local == null ? null : viewAt(view[VIEW_STATE], local) ?? null;
}

function setField(view: View, field: string, value: unknown): void {
  const state = view[VIEW_STATE];
  operation(routedFor(state), 'setNode', { id: state.base + view[VIEW_LOCAL], field, value });
}

function setPointer(view: View, field: string, value: unknown): void {
  setField(view, field, value == null ? null : importNodes(routedFor(view[VIEW_STATE]), [value])[0]);
}

function attributesOf(view: View): Record<string, string> {
  const state = view[VIEW_STATE];
  let attributes = view[VIEW_ATTRIBUTES];
  if (!attributes) view[VIEW_ATTRIBUTES] = attributes = createAttributes(view, state.options._useHtmlParser2 === false ? null : Object.prototype);
  if (attributes.generation !== state.generation || attributes.state !== state) syncAttributes(view, attributes);
  return attributes.proxy;
}

function createAttributes(view: View, prototype: object | null): AttributeView {
  const target: Record<string, string> = Object.create(prototype);
  // The node lives on the proxy's own handler, so the attribute object stays plain to reflection.
  const handler: AttributeView = Object.create(attributeWrites);
  handler.view = view;
  handler.target = target;
  handler.generation = -1;
  handler.state = view[VIEW_STATE];
  handler.proxy = new Proxy(target, handler);
  return handler;
}

/** Copies the record's attributes into the plain target, preserving key order. */
function syncAttributes(view: View, attributes: AttributeView): void {
  const { target } = attributes;
  const state = view[VIEW_STATE];
  const local = view[VIEW_LOCAL];
  if (attributes.generation === -1) {
    const snapshot = plainSnapshot(state, local);
    if (snapshot) {
      snapshot.copyAttributes(local, target);
      attributes.generation = state.generation;
      return;
    }
  }
  const values = viewRecord(view).attribs ?? {};
  const keys = Object.keys(target);
  const nextKeys = Object.keys(values);
  let isSameOrder = keys.length === nextKeys.length;
  for (let index = 0; isSameOrder && index < keys.length; index++) isSameOrder = keys[index] === nextKeys[index];
  if (!isSameOrder) for (const key of keys) delete target[key];
  for (const key of nextKeys) {
    if (isSameOrder && target[key] === values[key]) continue;
    if (key === '__proto__') Object.defineProperty(target, key, { value: values[key], writable: true, enumerable: true, configurable: true });
    else target[key] = values[key];
  }
  attributes.generation = view[VIEW_STATE].generation;
  attributes.state = view[VIEW_STATE];
}

/** Re-reads attributes for a node whose attributes a native command changed. */
function refreshAttributes(view: object): void {
  const attributes = (view as View)[VIEW_ATTRIBUTES];
  if (attributes) syncAttributes(view as View, attributes);
}
onViewRefresh(refreshAttributes, fillChildren);

/** Reads go straight to the plain target; writes go to Rust, which then refreshes the target. */
const attributeWrites: ProxyHandler<Record<string, string>> = {
  set(this: AttributeView, target, key, value) {
    if (typeof key === 'symbol') return Reflect.set(target, key, value);
    const view = this.view;
    setField(view, 'attribs', { ...viewRecord(view).attribs, [key]: String(value) });
    syncAttributes(view, view[VIEW_ATTRIBUTES]!);
    return true;
  },
  deleteProperty(this: AttributeView, target, key) {
    if (typeof key === 'symbol') return Reflect.deleteProperty(target, key);
    const view = this.view;
    const values = { ...viewRecord(view).attribs };
    delete values[key];
    setField(view, 'attribs', values);
    syncAttributes(view, view[VIEW_ATTRIBUTES]!);
    return true;
  },
  defineProperty(this: AttributeView, target, key, descriptor) {
    if (typeof key === 'symbol') return Reflect.defineProperty(target, key, descriptor);
    const view = this.view;
    setField(view, 'attribs', { ...viewRecord(view).attribs, [key]: String(descriptor.value) });
    syncAttributes(view, view[VIEW_ATTRIBUTES]!);
    return true;
  },
};

/** Namespace and prefix maps are rare; they read the record on every access. */
function attributeMap(view: View, field: 'attribsNamespace' | 'attribsPrefix'): Record<string, string> {
  const read = (): Record<string, string> => (viewRecord(view) as any)[field] ?? {};
  const target = Object.create(view[VIEW_STATE].options._useHtmlParser2 === false ? null : Object.prototype);
  const viewField = `x-${field}`;
  return new Proxy(target, {
    get(_target, key) {
      if (typeof key === 'symbol') return Reflect.get(target, key);
      const values = read();
      return Object.hasOwn(values, key) ? values[key] : Reflect.get(target, key);
    },
    set(_target, key, value) { setField(view, viewField, { ...read(), [key]: String(value) }); return true; },
    deleteProperty(_target, key) { const values = { ...read() }; delete values[key as string]; setField(view, viewField, values); return true; },
    ownKeys() { return Reflect.ownKeys(read()); },
    has(_target, key) { return Object.hasOwn(read(), key) || key in target; },
    getOwnPropertyDescriptor(_target, key) { const values = read(); return Object.hasOwn(values, key) ? { value: values[key as string], writable: true, enumerable: true, configurable: true } : undefined; },
    defineProperty(_target, key, descriptor) { setField(view, viewField, { ...read(), [key]: String(descriptor.value) }); return true; },
  });
}

/**
 * A node's children: a real array of node objects, so reads cost what
 * Cheerio's do. Its mutating methods write the whole list to Rust once, and
 * the router refills the array in place whenever Rust reports the parent
 * changed. Assigning an index or `length` directly changes only this array.
 * `constructor` is `Array`, so arrays derived from it are plain.
 */
class ChildArray extends Array<AnyNode> {
  readonly #view: View;
  constructor(view: View) {
    super();
    this.#view = view;
  }
  static viewOf(list: unknown): View | undefined {
    return list instanceof ChildArray ? list.#view : undefined;
  }
}
Object.defineProperty(ChildArray.prototype, 'constructor', { configurable: true, writable: true, value: Array });
for (const method of ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'copyWithin', 'fill'] as const) {
  Object.defineProperty(ChildArray.prototype, method, {
    configurable: true, writable: true,
    value(this: ChildArray, ...args: unknown[]) {
      const view = ChildArray.viewOf(this);
      if (!view) return Reflect.apply((Array.prototype as any)[method], this, args);
      const values = Array.from(this);
      const result = Reflect.apply((Array.prototype as any)[method], values, args);
      saveChildren(view, values);
      return result === values ? this : result;
    },
  });
}

function saveChildren(view: View, values: unknown[]): void {
  setField(view, 'children', importNodes(routedFor(view[VIEW_STATE]), values));
}

function childList(view: View): AnyNode[] {
  const existing = view[VIEW_CHILDREN];
  if (existing) return existing;
  const state = view[VIEW_STATE];
  if (!state.hasChildLists) { state.hasChildLists = true; state.raw.takeTouched?.(); }
  const list = new ChildArray(view);
  view[VIEW_CHILD_TARGET] = list;
  view[VIEW_CHILDREN] = list;
  fillChildren(view);
  return list;
}

/** Rebuilds a materialized child array from the node's current record. */
function fillChildren(view: object): void {
  const target = (view as View)[VIEW_CHILD_TARGET];
  if (!target) return;
  const state = (view as View)[VIEW_STATE];
  const local = (view as View)[VIEW_LOCAL];
  const snapshot = structureSnapshot(state, local);
  if (snapshot && state.stale.size === 0) {
    fillFromSnapshot(state, snapshot, local, target);
    return;
  }
  const locals = viewRecord(view as View).children ?? [];
  for (let index = 0; index < locals.length; index++) target[index] = viewAt(state, locals[index])!;
  truncate(target, locals.length);
}

/**
 * Children are written in order and the length is trimmed afterwards:
 * presetting the length of a fresh array makes it holey and costs more than
 * filling it.
 */
function truncate(target: AnyNode[], length: number): void {
  if (target.length !== length) target.length = length;
}

/**
 * The common case of a walk: a node's children read straight from the
 * snapshot arrays and cached strongly, with each type's constructor resolved
 * once per snapshot instead of once per node.
 */
function fillFromSnapshot(state: DocumentState, snapshot: NodeSnapshot, local: number, target: AnyNode[]): void {
  const count = snapshot.childCount(local);
  const first = snapshot.childStart(local);
  const childIds = snapshot.childIds;
  const views = state.views;
  const isStrong = !state.adapterNodes;
  const constructors = snapshotConstructors(state, snapshot);
  for (let index = 0; index < count; index++) {
    const child = childIds[first + index];
    let node = (views[child] ?? (state.weakViews.size ? cachedView(state, child) : undefined)) as AnyNode | undefined;
    if (node === undefined) {
      const constructor = isStrong && child < state.baseline && snapshot.isPresent(child) && !snapshot.hasExtraFields(child) ? constructors(snapshot.typeReference(child)) : undefined;
      if (constructor) views[child] = node = new constructor(state, child) as unknown as AnyNode;
      else node = viewAt(state, child)!;
    }
    target[index] = node;
  }
  truncate(target, count);
}

function snapshotConstructors(state: DocumentState, snapshot: NodeSnapshot): (reference: number) => ViewConstructor {
  let lookup = snapshot.viewConstructors as ((reference: number) => ViewConstructor) | undefined;
  if (!lookup) {
    const byReference: ViewConstructor[] = [];
    lookup = (reference) => byReference[reference] ??= viewConstructor(state, snapshot.name(reference), false);
    snapshot.viewConstructors = lookup;
  }
  return lookup;
}

type Accessor = { get(this: View): unknown; set(this: View, value: any): void };
const recordField = (field: string, fallback?: null): Accessor => ({
  get() { return (viewRecord(this) as any)[field] ?? fallback; },
  set(value) { setField(this, field, value); },
});
/** Fields read straight from the snapshot when it holds the node, without building a record. */
const snapshotField = (field: 'type' | 'name' | 'data'): Accessor => ({
  get() {
    const state = this[VIEW_STATE];
    const local = this[VIEW_LOCAL];
    const snapshot = field === 'data' ? plainSnapshot(state, local) : structureSnapshot(state, local);
    if (snapshot) return field === 'type' ? snapshot.typeOf(local) : field === 'name' ? snapshot.nameOf(local) : snapshot.dataOf(local);
    return (viewRecord(this) as any)[field];
  },
  set(value) { setField(this, field, value); },
});
const linkOffsets = { parent: 1, prev: 2, next: 3 } as const;
const pointerField = (field: 'parent' | 'prev' | 'next'): Accessor => ({
  get() {
    const state = this[VIEW_STATE];
    const local = this[VIEW_LOCAL];
    const snapshot = structureSnapshot(state, local);
    return linkedView(this, snapshot ? snapshot.linkOf(local, linkOffsets[field]) : viewRecord(this)[field]);
  },
  set(value) { setPointer(this, field, value); },
});
const nodeAccessors: Record<string, Accessor> = {
  type: snapshotField('type'),
  parent: pointerField('parent'),
  prev: pointerField('prev'),
  next: pointerField('next'),
  startIndex: recordField('startIndex', null),
  endIndex: recordField('endIndex', null),
};
/** Present only on nodes parsed with location info, as in Cheerio. */
const locationAccessor: Accessor = { get() { return hydrateLocation(viewRecord(this).sourceCodeLocation); }, set(value) { setField(this, 'sourceCodeLocation', value); } };
const childAccessors: Record<string, Accessor> = {
  children: { get() { return childList(this); }, set(value) { setField(this, 'children', importNodes(routedFor(this[VIEW_STATE]), value)); } },
};
const elementAccessors: Record<string, Accessor> = {
  name: snapshotField('name'),
  attribs: { get() { return attributesOf(this); }, set(value) { setField(this, 'attribs', value); } },
  namespace: recordField('namespace'),
  prefix: recordField('prefix'),
  'x-attribsNamespace': { get() { return viewRecord(this).attribsNamespace !== undefined ? attributeMap(this, 'attribsNamespace') : undefined; }, set(value) { setField(this, 'x-attribsNamespace', value); } },
  'x-attribsPrefix': { get() { return viewRecord(this).attribsPrefix !== undefined ? attributeMap(this, 'attribsPrefix') : undefined; }, set(value) { setField(this, 'x-attribsPrefix', value); } },
};
const dataAccessors: Record<string, Accessor> = { data: snapshotField('data') };
const directiveAccessors: Record<string, Accessor> = { name: recordField('name'), 'x-name': recordField('x-name'), 'x-publicId': recordField('x-publicId'), 'x-systemId': recordField('x-systemId') };
const documentAccessors: Record<string, Accessor> = { 'x-mode': recordField('x-mode') };

function accessorsFor(type: string): Record<string, Accessor> {
  switch (type) {
    case 'tag': case 'script': case 'style': return { ...nodeAccessors, ...childAccessors, ...elementAccessors };
    case 'root': return { ...nodeAccessors, ...childAccessors, ...documentAccessors };
    case 'cdata': return { ...nodeAccessors, ...childAccessors };
    case 'directive': return { ...nodeAccessors, ...dataAccessors, ...directiveAccessors };
    case 'text': case 'comment': return { ...nodeAccessors, ...dataAccessors };
    default: return { ...nodeAccessors, ...childAccessors, ...dataAccessors, name: recordField('name') };
  }
}

type ViewConstructor = new (state: DocumentState, local: number) => View;
const viewConstructors = new Map<string, ViewConstructor>();
const plainConstructors: Record<string, ViewConstructor | undefined> = Object.create(null);

/**
 * Legacy (Cheerio 0.22.0) node-shape rules, enabled per document through the
 * `_legacyDom` option:
 * - a top-level node's `parent` reads as null; its document root is exposed
 *   through the separate `root` field instead;
 * - every node carries a writable `root` field, stored on the JavaScript side
 *   exactly like the plain-object field of the original library;
 * - the synthetic root keeps its `name` of "root" and an `attribs` object.
 */
const rootReferences = new WeakMap<object, unknown>();
const legacyParentAccessor: Accessor = {
  get() {
    const state = this[VIEW_STATE];
    const local = this[VIEW_LOCAL];
    const snapshot = structureSnapshot(state, local);
    const parentLocal = snapshot ? snapshot.linkOf(local, 1) : viewRecord(this).parent;
    if (parentLocal == null) return null;
    if (parentLocal === state.rootLocal) return null;
    return linkedView(this, parentLocal);
  },
  set(value) { setPointer(this, 'parent', value); },
};
const legacyRootAccessor: Accessor = {
  get() { return rootReferences.get(this); },
  set(value) { rootReferences.set(this, value); },
};

function legacyAccessors(type: string): Record<string, Accessor> {
  const accessors: Record<string, Accessor> = { parent: legacyParentAccessor, root: legacyRootAccessor };
  if (type === 'root') accessors.name = { get: () => 'root', set(value) { setField(this, 'name', value); } };
  // domhandler 2.4.2 defines the DOM Lvl 1 aliases on every node prototype.
  accessors.tagName = { get() { return this.name || null; }, set(value) { this.name = value; } };
  accessors.nodeValue = { get() { return this.data || null; }, set(value) { this.data = value; } };
  return accessors;
}

/**
 * The own fields of a 0.22.0 node object, per node kind. Legacy views define
 * these as own enumerable accessor properties so that enumeration
 * (`Object.keys(node)`) and deep-equality checks behave like they do on the
 * original plain-object nodes.
 */
const legacyOwnFields: Record<string, string[]> = {
  root: ['type', 'name', 'attribs', 'children', 'parent', 'prev', 'next'],
  tag: ['type', 'name', 'attribs', 'children', 'parent', 'prev', 'next'],
  script: ['type', 'name', 'attribs', 'children', 'parent', 'prev', 'next'],
  style: ['type', 'name', 'attribs', 'children', 'parent', 'prev', 'next'],
  cdata: ['type', 'children', 'parent', 'prev', 'next'],
  directive: ['type', 'name', 'data', 'parent', 'prev', 'next'],
  text: ['type', 'data', 'parent', 'prev', 'next'],
  comment: ['type', 'data', 'parent', 'prev', 'next'],
};

/** One constructor per node shape so node objects share a hidden class and prototype. */
function viewConstructor(state: DocumentState, type: string, hasLocation: boolean): ViewConstructor {
  const legacy = state.options._legacyDom === true;
  const suffix = hasLocation ? ':location' : '';
  const key = legacy ? `${type}${suffix}:legacy` : `${type}${suffix}`;
  if (!hasLocation && !legacy) { const plain = plainConstructors[type]; if (plain) return plain; }
  let constructor = viewConstructors.get(key);
  if (constructor) return constructor;
  const prototype = Object.create(nodePrototype(type));
  let accessors = hasLocation ? { ...accessorsFor(type), sourceCodeLocation: locationAccessor } : accessorsFor(type);
  if (legacy) accessors = { ...accessors, ...legacyAccessors(type), ...(type === 'root' ? { attribs: elementAccessors.attribs } : {}) };
  const childrenDescriptor = 'children' in accessors ? { ...childAccessors.children, configurable: true, enumerable: true } : undefined;
  for (const [field, accessor] of Object.entries(accessors)) Object.defineProperty(prototype, field, { ...accessor, configurable: true, enumerable: false });
  constructor = function (this: View, state: DocumentState, local: number) {
    this[VIEW_STATE] = state;
    this[VIEW_LOCAL] = local;
    this[VIEW_SELF] = this;
    this[VIEW_ATTRIBUTES] = undefined;
    this[VIEW_CHILDREN] = undefined;
    this[VIEW_CHILD_TARGET] = undefined;
    if (childrenDescriptor) Object.defineProperty(this, 'children', childrenDescriptor);
    if (legacy) {
      // Own enumerable fields for the 0.22.0 node shape, reading and writing
      // through the live accessors.
      const fields = legacyOwnFields[type];
      if (fields) {
        for (const field of fields) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, field);
          if (descriptor && (descriptor.get || descriptor.set)) {
            Object.defineProperty(this, field, { get: descriptor.get, set: descriptor.set, configurable: true, enumerable: true });
          }
        }
      }
    }
  } as unknown as ViewConstructor;
  Object.defineProperty(prototype, inspectSymbol, { configurable: true, writable: true, value: inspectNode });
  constructor.prototype = prototype;
  viewConstructors.set(key, constructor);
  if (!hasLocation && !legacy) plainConstructors[type] = constructor;
  return constructor;
}

const inspectSymbol = Symbol.for('nodejs.util.inspect.custom');
const inspectedFields = ['type', 'name', 'data', 'attribs', 'namespace', 'startIndex', 'endIndex'];

/** Console output shows the node's fields instead of its native bookkeeping. */
function inspectNode(this: View, depth: number, options: object, inspect: (value: unknown, options: object) => string): string {
  const fields: Record<string, unknown> = {};
  for (const field of inspectedFields) if (field in this && this[field] != null) fields[field] = field === 'attribs' ? { ...this.attribs } : this[field];
  if ('children' in this) fields.children = `[${this.children.length} nodes]`;
  const name = Object.getPrototypeOf(Object.getPrototypeOf(this))?.constructor?.name ?? 'Node';
  return depth < 0 ? `[${name}]` : `${name} ${inspect(fields, { ...options, depth: 1 })}`;
}

const adoptedAliases: PropertyDescriptorMap = {
  parentNode: { configurable: true, enumerable: false, get(this: View) { return this.parent; }, set(this: View, value) { this.parent = value; } },
  previousSibling: { configurable: true, enumerable: false, get(this: View) { return this.prev; }, set(this: View, value) { this.prev = value; } },
  nextSibling: { configurable: true, enumerable: false, get(this: View) { return this.next; }, set(this: View, value) { this.next = value; } },
  nodeType: { configurable: true, enumerable: false, get(this: View) { return ({ root: 9, text: 3, comment: 8, cdata: 4 } as Record<string, number>)[viewRecord(this).type] ?? 1; } },
  cloneNode: { configurable: true, enumerable: false, writable: true, value: cloneNode },
};
const adoptedChildAliases: PropertyDescriptorMap = {
  childNodes: { configurable: true, enumerable: false, get(this: View) { return this.children; }, set(this: View, value) { this.children = value; } },
  firstChild: { configurable: true, enumerable: false, get(this: View) { return this.children[0] ?? null; } },
  lastChild: { configurable: true, enumerable: false, get(this: View) { return this.children[this.children.length - 1] ?? null; } },
};
const adoptedElementAliases: PropertyDescriptorMap = {
  tagName: { configurable: true, enumerable: false, get(this: View) { return this.name; }, set(this: View, value) { this.name = value; } },
  attributes: { configurable: true, enumerable: false, get(this: View) { const attributes = this.attribs; const record = viewRecord(this); return Object.keys(attributes).map((name) => ({ name, value: attributes[name], namespace: record.attribsNamespace?.[name], prefix: record.attribsPrefix?.[name] })); } },
};
const adoptedDataAliases: PropertyDescriptorMap = {
  nodeValue: { configurable: true, enumerable: false, get(this: View) { return this.data; }, set(this: View, value) { this.data = value; } },
};
const adoptedFields = new Map<string, PropertyDescriptorMap>();
const optionalAdoptedKeys = ['name', 'data', 'namespace', 'prefix', 'sourceCodeLocation', 'x-name', 'x-publicId', 'x-systemId', 'x-mode', 'x-attribsNamespace', 'x-attribsPrefix'];
const optionalAdoptedFields = new Set(optionalAdoptedKeys);
const adoptedShapes = new Map<string, PropertyDescriptorMap>();

/**
 * Binds an object created outside the arena (a DOM constructor or a parser
 * hook's node) to its native node, keeping the caller's object identity.
 */
function adoptObject(state: DocumentState, local: number, original: any): AnyNode {
  const record = recordAt(state, local);
  if (!record) return undefined as unknown as AnyNode;
  const view = original as View;
  const attributesPrototype = original.attribs && typeof original.attribs === 'object' ? Object.getPrototypeOf(original.attribs) : undefined;
  view[VIEW_STATE] = state;
  view[VIEW_LOCAL] = local;
  view[VIEW_SELF] = view;
  view[VIEW_ATTRIBUTES] = undefined;
  view[VIEW_CHILDREN] = undefined;
  view[VIEW_CHILD_TARGET] = undefined;
  let fields = adoptedFields.get(record.type);
  if (!fields) {
    fields = {};
    for (const [key, accessor] of Object.entries({ ...accessorsFor(record.type), sourceCodeLocation: locationAccessor })) fields[key] = { ...accessor, configurable: true, enumerable: true };
    adoptedFields.set(record.type, fields);
  }
  // Which optional fields a node has varies; each combination's full descriptor map is built once.
  let shape = record.type;
  for (const key of optionalAdoptedKeys) {
    if (!(key in fields)) continue;
    const field = key === 'x-attribsNamespace' ? 'attribsNamespace' : key === 'x-attribsPrefix' ? 'attribsPrefix' : key;
    shape += (record as any)[field] !== undefined || Object.hasOwn(original, key) ? '1' : '0';
  }
  let descriptors = adoptedShapes.get(shape);
  if (!descriptors) {
    const present: PropertyDescriptorMap = {};
    for (const key in fields) {
      const field = key === 'x-attribsNamespace' ? 'attribsNamespace' : key === 'x-attribsPrefix' ? 'attribsPrefix' : key;
      if (optionalAdoptedFields.has(key) && (record as any)[field] === undefined && !Object.hasOwn(original, key)) continue;
      present[key] = fields[key];
    }
    const isParent = 'children' in present;
    const isData = record.type === 'text' || record.type === 'comment' || record.type === 'directive';
    descriptors = { ...present, ...adoptedAliases, ...(isParent ? adoptedChildAliases : {}), ...(isElementType(record.type) ? adoptedElementAliases : {}), ...(isData ? adoptedDataAliases : {}) };
    adoptedShapes.set(shape, descriptors);
  }
  const isElement = isElementType(record.type);
  try {
    Object.defineProperties(view, descriptors);
  } catch {
    // Foreign user properties may be non-configurable; those keep their values.
  }
  if (isElement && attributesPrototype !== undefined) view[VIEW_ATTRIBUTES] = createAttributes(view, attributesPrototype);
  cacheView(state, local, view);
  return view as unknown as AnyNode;
}

/**
 * Registers a tree adapter's nodes for the document's slots. Each node can be
 * passed back to the API at once; its fields become live when first returned.
 */
export function attachParsedNodes(state: DocumentState, nodes: (object | undefined)[]): void {
  state.adapterNodes = nodes;
  for (let local = 0; local < nodes.length; local++) {
    const node = nodes[local] as View | undefined;
    if (!node) continue;
    node[VIEW_STATE] = state;
    node[VIEW_LOCAL] = local;
    node[VIEW_SELF] = node;
  }
}

/** Clone through the receiver's current native owner, including borrowed calls. */
export function cloneNode<T extends AnyNode>(this: T, recursive = false): T {
  const binding = nodeBinding(this);
  if (!binding) throw new TypeError('cloneNode requires a native DOM node receiver');
  return getNode(binding.document, operation<number[]>(binding.document, 'clone', { ids: [binding.id], deep: recursive })[0]) as T;
}

function childIds(document: NativeDocument, id: number): number[] {
  const state = stateIn(document, id);
  return (recordAt(state, id - state.base)?.children ?? []).map((child) => state.base + child);
}

/** Import external DOM nodes once and keep their object identities as handles. */
export function importNodes(document: NativeDocument, input: unknown): number[] {
  if (input == null || input === false) return [];
  const values: any[] = Array.isArray(input) || (typeof input === 'object' && 'length' in input && !('type' in input)) ? Array.from(input as ArrayLike<any>) : [input];
  const result: number[] = [];
  for (const node of values) {
    if (node == null) continue;
    const existing = node && typeof node === 'object' ? viewIdIn(document, node) : undefined;
    if (existing !== undefined) { result.push(existing); continue; }
    if (typeof node !== 'object' || typeof node.type !== 'string') continue;
    const records: any[] = [];
    const originals = new Map<number, any>();
    const visit = (value: any, parent?: number): number => {
      const id = records.length;
      const record: any = { id, type: value.type, children: [], ...(parent === undefined ? {} : { parent }) };
      records.push(record); originals.set(id, value);
      for (const field of ['name', 'data', 'namespace', 'prefix', 'startIndex', 'endIndex', 'sourceCodeLocation', 'x-name', 'x-publicId', 'x-systemId', 'x-mode']) if (value[field] !== undefined) record[field] = value[field];
      if (value.attribs) record.attribs = { ...value.attribs };
      if (value['x-attribsNamespace']) record.attribsNamespace = { ...value['x-attribsNamespace'] };
      if (value['x-attribsPrefix']) record.attribsPrefix = { ...value['x-attribsPrefix'] };
      record.children = (value.children ?? []).map((child: any) => visit(child, id));
      return id;
    };
    const root = visit(node);
    const imported = operation<number[]>(document, 'import', { nodes: records, roots: [root] });
    if (!imported.length) continue;
    const adopt = (oldId: number, newId: number): void => {
      const source = originals.get(oldId);
      const oldChildren = records[oldId].children;
      const newChildren = childIds(document, newId);
      // A node already belonging to another Rust document must retain its
      // original document handle. Imported clones receive their own handles.
      getNode(document, newId, isNativeNode(source) ? undefined : source);
      for (let i = 0; i < oldChildren.length; i++) if (newChildren[i] !== undefined) adopt(oldChildren[i], newChildren[i]);
    };
    adopt(root, imported[0]);
    result.push(imported[0]);
  }
  return result;
}

export const isTag = (node: any): boolean => !!node && isElementType(node.type);
export const isDocument = (node: any): boolean => node?.type === 'root';
export const hasChildren = (node: any): boolean => !!node && 'children' in node;
