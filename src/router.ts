import { packageDirectory, requireNative, type NativeDocument, type NativeNodeRecord } from './native.js';
import { hasParserHooks, parseNativeDocument } from './hooks.js';
import type { CheerioOptions } from './types.js';
import { NodeSnapshot, plainRecord, type NativeSnapshot } from './snapshot.js';

interface NativeMemoryStats { live: number; slots: number; retained: number; reclaimed: number; immutableNodes: number; externalBytes: number }
interface PinnedCollection extends NativeMemoryStats { free: Uint32Array }
interface ManagedNativeDocument extends NativeDocument {
  setAttribute?(ids: number[], name: string, value: string | null): void;
  slotCount?(): number;
  routingIndex?(): number;
  detachedSlots?(root: number): Uint32Array;
  render?(ids: number[], optionsJson?: string): string;
  snapshot?(): NativeSnapshot;
  takeTouched?(): Uint32Array | null;
  collectPinned?(pins: Uint32Array, keepBelow?: number): PinnedCollection;
  collectGarbage?(): NativeMemoryStats;
  isCollectionDue?(): boolean;
}

/**
 * A node id is `state.base + local`, where `local` indexes the node in its
 * native arena. Ids from different documents never collide, so every routed
 * document shares one id space without a lookup table per node.
 */
const STRIDE = 2 ** 32;
/** Ids must stay exact doubles, which bounds how many documents may be alive at once. */
const maximumDocuments = 2 ** 21;
/** A document's root is its first slot; collections keep it and everything attached to it. */
const rootSlots = 1;

/**
 * Ids held by a JavaScript owner. Collection keeps them; moves rewrite them in
 * place. The finalization registry holds only the token, which references
 * nothing: its cleanup runs only once the event loop turns, and anything it
 * held would keep documents of a synchronous loop alive until then.
 */
export interface Lease { ids: number[]; token: LeaseToken; states: DocumentState[] }
interface LeaseToken { isReleased: boolean }

/**
 * JavaScript `.data()` storage for one node; moves carry it to the node's new
 * arena. A collection that frees the node releases it, so data objects still
 * held no longer write to whatever node reuses the slot.
 */
export interface DataEntry { state: DocumentState; local: number; data?: object; isReleased?: boolean }

/** Bookkeeping for one native document. */
export interface DocumentState {
  readonly raw: ManagedNativeDocument;
  readonly base: number;
  /** The id space the state's base belongs to: another copy of the package numbers its documents separately. */
  readonly space: object;
  readonly options: CheerioOptions;
  rootLocal: number | undefined;
  routed: RoutedDocument | undefined;
  generation: number;
  records: (NativeNodeRecord | null | undefined)[];
  bulk: NodeSnapshot | number;
  snapshotSize: number;
  /** Nodes whose snapshot entry is outdated by a targeted write. */
  stale: Set<number>;
  /**
   * Node objects for slots that existed at parse time, until a collection
   * finds their nodes detached; an array read is far cheaper than a map
   * lookup.
   */
  views: (object | undefined)[];
  /** Node objects for slots created later, until a collection finds their nodes detached. */
  looseViews: Map<number, object>;
  /** Size of `looseViews` at which a collection is scheduled. */
  looseViewLimit: number;
  /** Node objects for detached nodes, kept only while something else holds them. */
  weakViews: Map<number, WeakRef<object>>;
  /** Slots that existed when the document was parsed. */
  baseline: number;
  /** Later collections to run while weakened node objects may still become unreachable. */
  collectionRetries: number;
  /** Whether a collection was due but the document left the pending list; its next use schedules it again. */
  isCollectionEvicted: boolean;
  /** Whether the native document holds a snapshot built while parsing, valid until the first write. */
  hasPreparedSnapshot: boolean;
  leases: Set<Lease>;
  /** Lease count at which released leases are swept. */
  leaseSweepSize: number;
  data: Map<number, DataEntry>;
  /**
   * Whether the id table resolves this document. Only ids that reach another
   * document need it, and the `WeakRef` it takes keeps the document alive
   * until the current job ends.
   */
  isExposed: boolean;
  /**
   * Documents whose ids this document's selections or leases may hold. A
   * document's index is reused once it is collected, so holders keep it.
   */
  /** Some node object holds a child array that must follow structural writes. */
  hasChildLists: boolean;
  /** A tree adapter's nodes not yet returned to the caller, by slot. */
  adapterNodes?: (object | undefined)[];
}

/** Fields on node objects; registered symbols so ESM and CJS copies share nodes. */
export const VIEW_STATE = Symbol.for('rusteerio.node.state');
export const VIEW_LOCAL = Symbol.for('rusteerio.node.local');
export const VIEW_ATTRIBUTES = Symbol.for('rusteerio.node.attributes');
/** Points at the node itself, so a spread copy of a node is not mistaken for it. */
export const VIEW_SELF = Symbol.for('rusteerio.node.self');
// Internals are own properties under symbols: reads stay plain property
// loads, which prototype accessors are not on selections of many documents'
// classes, and selections enumerate like Cheerio's. Registered symbols let
// the ESM and CommonJS builds read each other's selections.
export const DOCUMENT: unique symbol = Symbol.for('rusteerio.selection.document');
export const API: unique symbol = Symbol.for('rusteerio.selection.api');
export const IDS: unique symbol = Symbol.for('rusteerio.selection.ids');
export const VALUES: unique symbol = Symbol.for('rusteerio.selection.values');
export const LEASE: unique symbol = Symbol.for('rusteerio.selection.lease');
export const IS_PLAIN: unique symbol = Symbol.for('rusteerio.selection.is-plain');
/** A node object's materialized `children` array, refilled when the node's children change. */
export const VIEW_CHILD_TARGET = Symbol.for('rusteerio.node.child-target');

interface Registry {
  space: object;
  /** Writes to any document, so callers can tell whether values they read earlier may be stale. */
  writes: number;
  states: (WeakRef<DocumentState> | undefined)[];
  pending: Set<DocumentState>;
  isScheduled: boolean;
  leaseFinalizer: FinalizationRegistry<LeaseToken>;
}
// Each installed copy of the package loads its own addon, which numbers its
// documents independently, so only entry points of one copy share ids.
const registryKey = Symbol.for(`rusteerio.native-documents.v5:${packageDirectory()}`);
/** A native document's state lives on the document itself, so they share one lifetime. */
const stateKey = Symbol.for('rusteerio.native-documents.state');
const globals = globalThis as typeof globalThis & { [key: symbol]: Registry | undefined };
const registry: Registry = globals[registryKey] ??= (() => {
  const created: Registry = {
    space: {},
    writes: 0,
    states: [],
    pending: new Set(),
    isScheduled: false,
    leaseFinalizer: new FinalizationRegistry((token) => { token.isReleased = true; }),
  };
  return created;
})();

/** The states owning `ids`, resolved through `document`. */
function statesOf(document: NativeDocument, ids: readonly number[]): DocumentState[] {
  const states: DocumentState[] = [];
  let previous: DocumentState | undefined;
  for (const id of ids) {
    // Selections may hold holes after direct index writes.
    if (id === undefined) continue;
    if (previous && id >= previous.base && id < previous.base + STRIDE) continue;
    const state = stateIn(document, id);
    if (!states.includes(state)) states.push(state);
    previous = state;
  }
  return states;
}

/**
 * Collects once a structural write leaves the arena grown by half with nodes
 * removed; collecting sooner costs more than the garbage it would free.
 */
function scheduleCollectionIfDue(state: DocumentState): void {
  if (state.raw.isCollectionDue?.()) scheduleCollection(state);
}

/**
 * Collections run on a later turn of the event loop: no library call is then
 * between native writes holding ids of nodes it has just detached, and node
 * objects weakened on an earlier turn may have been reclaimed.
 */
function scheduleCollection(state: DocumentState): void {
  registry.pending.add(state);
  // Pending documents are held strongly until the event loop turns; in a
  // synchronous loop only the latest few stay pinned. Holding the others
  // weakly would pin them too: a WeakRef keeps its target until the
  // synchronous job ends. An evicted document is scheduled again on its next
  // use; one never used again is either collected whole or idle.
  if (registry.pending.size > maximumPendingCollections) {
    const evicted = registry.pending.values().next().value!;
    registry.pending.delete(evicted);
    evicted.isCollectionEvicted = true;
  }
  if (registry.isScheduled) return;
  registry.isScheduled = true;
  setImmediate(() => {
    registry.isScheduled = false;
    const states = [...registry.pending];
    registry.pending.clear();
    for (const pending of states) collectState(pending);
  }).unref();
}

const maximumPendingCollections = 4;

/** Increases with every write to any document. */
export function writeCount(): number {
  return registry.writes;
}

/**
 * The state of a native document, created on first use. The addon hands out
 * routing indexes and takes one back when its document is finalized, which
 * happens during garbage collection, so indexes recycle even within a
 * synchronous loop.
 */
export function stateFor(raw: NativeDocument, options: CheerioOptions = {}): DocumentState {
  const holder = raw as unknown as { [stateKey]?: DocumentState };
  const existing = holder[stateKey];
  if (existing) return existing;
  const index = (raw as ManagedNativeDocument).routingIndex!();
  if (index >= maximumDocuments) throw new RangeError('Too many documents are alive at once.');
  const baseline = (raw as ManagedNativeDocument).slotCount?.() ?? 0;
  const state: DocumentState = {
    raw: raw as ManagedNativeDocument, base: index * STRIDE, space: registry.space, options, rootLocal: undefined, routed: undefined,
    // Sized up front: node objects are cached out of order, and regrowing a holey array is costly.
    generation: 0, records: [], bulk: 0, snapshotSize: 0, stale: new Set(), views: new Array(baseline), looseViews: new Map(), looseViewLimit: minimumLooseViewLimit, weakViews: new Map(), baseline,
    leases: new Set(), leaseSweepSize: 64, data: new Map(), isExposed: false, hasChildLists: false, collectionRetries: 0, isCollectionEvicted: false, hasPreparedSnapshot: false,
  };
  holder[stateKey] = state;
  return state;
}

/** Lets ids of `state` be resolved from documents other than its own. */
function exposeState(state: DocumentState): void {
  if (state.isExposed) return;
  state.isExposed = true;
  registry.states[state.base / STRIDE] = new WeakRef(state);
}

/**
 * Called before ids of `state` enter operations or selections of `document`.
 * Leases keep the documents of the ids a selection holds; node objects keep
 * their own.
 */
export function exposeTo(document: NativeDocument, state: DocumentState): void {
  if ((document as Partial<RoutedDocument>).state === state) return;
  exposeState(state);
}

/** Called before a selection's ids enter operations of `document`. */
export function exposeDocumentTo(document: NativeDocument, source: NativeDocument | undefined): void {
  const state = (source as Partial<RoutedDocument> | undefined)?.state;
  if (state) exposeTo(document, state);
}

/** The node object cached for a slot, if any. */
export function cachedView(state: DocumentState, local: number): object | undefined {
  const view = local < state.baseline ? state.views[local] : state.looseViews.get(local);
  return view ?? (state.weakViews.size ? state.weakViews.get(local)?.deref() : undefined);
}

/** Created nodes held as objects only become collectable through a collection. */
const minimumLooseViewLimit = 1024;

export function cacheView(state: DocumentState, local: number, view: object): void {
  if (local < state.baseline) { state.views[local] = view; return; }
  state.looseViews.set(local, view);
  if (state.looseViews.size >= state.looseViewLimit) {
    state.looseViewLimit = state.looseViews.size * 2;
    scheduleCollection(state);
  }
}

function uncacheView(state: DocumentState, local: number): object | undefined {
  const view = cachedView(state, local);
  if (local < state.baseline) state.views[local] = undefined;
  state.looseViews.delete(local);
  state.weakViews.delete(local);
  return view;
}

/** A collection drops released slots at the arena's end; later nodes reuse their indexes. */
function releaseSlotsFrom(state: DocumentState, end: number): void {
  for (const local of state.data.keys()) if (local >= end) releaseSlot(state, local);
  for (const local of state.weakViews.keys()) if (local >= end) state.weakViews.delete(local);
  if (state.adapterNodes && state.adapterNodes.length > end) {
    for (let local = end; local < state.adapterNodes.length; local++) releaseAdapterNode(state, local);
    state.adapterNodes.length = end;
  }
}

/** Forgets everything bound to a slot a collection freed. */
function releaseSlot(state: DocumentState, local: number): void {
  uncacheView(state, local);
  const entry = state.data.get(local);
  if (entry) { entry.isReleased = true; state.data.delete(local); }
  releaseAdapterNode(state, local);
}

/** Hands a freed slot's tree adapter object back to the caller: passed in again, it is imported like any other node. */
function releaseAdapterNode(state: DocumentState, local: number): void {
  const adapterNode = state.adapterNodes?.[local] as Record<symbol, unknown> | undefined;
  if (!adapterNode) return;
  adapterNode[VIEW_SELF] = undefined;
  state.adapterNodes![local] = undefined;
}

function hasViews(state: DocumentState): boolean {
  return state.views.length > 0 || state.looseViews.size > 0 || state.weakViews.size > 0;
}

function forEachView(state: DocumentState, visit: (view: object, local: number) => void): void {
  state.views.forEach((view, local) => { if (view) visit(view, local); });
  for (const [local, view] of state.looseViews) visit(view, local);
  for (const [local, reference] of state.weakViews) { const view = reference.deref(); if (view) visit(view, local); }
}

/**
 * Node objects of detached nodes stay cached only while something else holds
 * them, so a later collection can reclaim their nodes. The `WeakRef`s are
 * taken during a collection rather than on removal: taking one keeps its
 * target, and so its document, alive until the current job ends. Returns
 * whether any node object was weakened.
 */
function weakenDetachedViews(state: DocumentState): boolean {
  if (!state.raw.detachedSlots) return false;
  let isWeakened = false;
  for (const local of state.raw.detachedSlots(state.rootLocal ??= state.raw.rootId())) {
    const view = local < state.baseline ? state.views[local] : state.looseViews.get(local);
    if (!view) continue;
    if (local < state.baseline) state.views[local] = undefined;
    else state.looseViews.delete(local);
    state.weakViews.set(local, new WeakRef(view));
    isWeakened = true;
  }
  return isWeakened;
}

/** The state owning `id` of a document whose ids have reached other documents. */
function exposedStateOf(id: number): DocumentState {
  const state = registry.states[Math.floor(id / STRIDE)]?.deref();
  if (!state || !(id >= 0)) throw new RangeError(`Unknown native node handle ${id}`);
  return state;
}

/** The state owning `id`, resolved without the weak table when `document` owns it. */
export function stateIn(document: NativeDocument, id: number): DocumentState {
  const own = (document as Partial<RoutedDocument>).state;
  if (own === undefined || id < own.base || id >= own.base + STRIDE) return exposedStateOf(id);
  if (own.isCollectionEvicted) resumeCollection(document);
  return own;
}

/** Schedules again a collection that left the pending list before it ran. */
export function resumeCollection(document: NativeDocument): void {
  const state = (document as Partial<RoutedDocument>).state;
  if (!state?.isCollectionEvicted) return;
  state.isCollectionEvicted = false;
  scheduleCollection(state);
}

/** The node's record for the current generation, with ids local to `state`. */
export function recordAt(state: DocumentState, local: number): NativeNodeRecord | null {
  const cached = state.records[local];
  if (cached !== undefined) return cached;
  const record = readRecord(state, local);
  state.records[local] = record;
  return record;
}

const minimumReadsBeforeSnapshot = 64;

/**
 * Once individual reads in a generation cost about as much as copying every
 * record, take one snapshot and decode the rest locally. A snapshot costs
 * about two reads plus one read per hundred nodes, and a document read once
 * is usually read again, so an unchanged document of under a hundred nodes
 * takes one on its first read. Mutations start a new generation.
 */
function readRecord(state: DocumentState, local: number): NativeNodeRecord | null {
  const bulk = state.bulk;
  if (bulk instanceof NodeSnapshot) {
    const record = state.stale.size && state.stale.has(local) ? undefined : bulk.record(local);
    if (record !== undefined) return record;
  } else if (state.raw.snapshot) {
    const reads = bulk + 1;
    const size = Math.max(state.snapshotSize, state.baseline);
    // An unchanged small document is read throughout; after a write, often only a few nodes are.
    const firstSnapshotRead = state.generation === 0 ? size / 100 : 1 + size / 100;
    if (reads >= Math.min(minimumReadsBeforeSnapshot, firstSnapshotRead)) {
      const snapshot = new NodeSnapshot(takePreparedSnapshot(state, true) ?? state.raw.snapshot());
      state.snapshotSize = snapshot.size;
      state.bulk = snapshot;
      const record = snapshot.record(local);
      if (record !== undefined) return record;
    } else state.bulk = reads;
  }
  return rawOperation(state.raw, 'node', { id: local });
}

/**
 * Lets a routed document nothing has read or changed yet use the snapshot
 * its native document built while parsing, when its reads first need one.
 */
export function usePreparedSnapshot(document: NativeDocument): void {
  if (!(document instanceof RoutedDocument)) return;
  const state = document.state;
  state.hasPreparedSnapshot = state.generation === 0 && state.bulk === 0;
}

function takePreparedSnapshot(state: DocumentState, isWanted: boolean): NativeSnapshot | undefined {
  if (!state.hasPreparedSnapshot) return undefined;
  state.hasPreparedSnapshot = false;
  return state.raw.takePreparedSnapshot?.(isWanted) ?? undefined;
}

/** The current snapshot when it holds `local` exactly, so its fields can be read without a record. */
export function plainSnapshot(state: DocumentState, local: number): NodeSnapshot | undefined {
  const bulk = state.bulk;
  return bulk instanceof NodeSnapshot && !(state.stale.size && state.stale.has(local)) && bulk.isPlain(local) ? bulk : undefined;
}

/**
 * The current snapshot when it holds `local`'s type, name, links and
 * children. Those are kept for every node, also one whose large text or
 * attributes must be read individually.
 */
export function structureSnapshot(state: DocumentState, local: number): NodeSnapshot | undefined {
  const bulk = state.bulk;
  return bulk instanceof NodeSnapshot && !(state.stale.size && state.stale.has(local)) && bulk.isPresent(local) ? bulk : undefined;
}

/** Nodes a JavaScript `text()` reads before leaving larger subtrees to the native engine. */
const snapshotTextBudget = 256;

/**
 * The text of a small subtree read from the snapshot, as the native `text`
 * concatenates it, or `undefined` to ask the native engine. Text too large
 * for the snapshot is read once per snapshot, so repeated reads do not copy
 * it out of the native tree again.
 */
function textFromSnapshot(state: DocumentState, local: number): string | undefined {
  let text = '';
  const stack = [local];
  for (let visited = 0; stack.length; visited++) {
    const node = stack.pop()!;
    const snapshot = structureSnapshot(state, node);
    if (!snapshot || visited === snapshotTextBudget) return undefined;
    if (snapshot.isTextAt(node)) {
      text += snapshot.dataOf(node) ?? largeText(state, snapshot, node);
      continue;
    }
    for (let index = snapshot.childCount(node) - 1; index >= 0; index--) stack.push(snapshot.childAt(node, index));
  }
  return text;
}

function largeText(state: DocumentState, snapshot: NodeSnapshot, local: number): string {
  let text = snapshot.largeTexts.get(local);
  if (text === undefined) snapshot.largeTexts.set(local, text = state.raw.text([local]));
  return text;
}

/** A string attribute of an element, read like the native `attr` lookup. */
export function attributeAt(state: DocumentState, local: number, name: string): string | undefined {
  const snapshot = plainSnapshot(state, local);
  if (snapshot) return snapshot.attributeValue(local, name);
  const attributes = recordAt(state, local)?.attribs as Record<string, unknown> | undefined;
  const value = attributes && Object.hasOwn(attributes, name) ? attributes[name] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** Starts a new generation: cached records may no longer match the arena. */
export function invalidate(state: DocumentState): void {
  takePreparedSnapshot(state, false);
  state.generation++;
  state.records = [];
  state.bulk = 0;
  state.stale.clear();
}

function refreshSerializedNodes(state: DocumentState, options: CheerioOptions): void {
  if (!options._useHtmlParser2 || options.xmlMode) return;
  const touched = state.raw.takeTouched?.();
  if (touched === null) invalidate(state);
  else if (touched?.length) invalidateNodes(state, touched);
}

/** Discards the records of nodes a write changed without touching the tree's shape. */
function invalidateNodes(state: DocumentState, locals: Iterable<number>): void {
  takePreparedSnapshot(state, false);
  const isSnapshot = state.bulk instanceof NodeSnapshot;
  const { records } = state;
  for (const local of locals) {
    // Writing past the end would grow the cache with holes, which V8 turns
    // into a slow dictionary for far indexes.
    if (records[local] !== undefined) records[local] = undefined;
    if (isSnapshot) state.stale.add(local);
  }
}

/** Keeps the ids of `document` that `owner` holds alive, and rewrites them when their nodes move. */
export function leaseNodes(document: NativeDocument, owner: object, ids: number[]): Lease {
  const token: LeaseToken = { isReleased: false };
  const states = statesOf(document, ids);
  const lease: Lease = { ids, token, states };
  for (const state of states) addLease(state, lease);
  registry.leaseFinalizer.register(owner, token);
  return lease;
}

/** Points a lease at a replacement id list. */
export function updateLease(document: NativeDocument, lease: Lease, ids: number[]): void {
  lease.ids = ids;
  lease.states = statesOf(document, ids);
  for (const state of lease.states) addLease(state, lease);
}

function addLease(state: DocumentState, lease: Lease): void {
  state.leases.add(lease);
  if (state.leases.size < state.leaseSweepSize) return;
  for (const held of state.leases) if (held.token.isReleased) state.leases.delete(held);
  state.leaseSweepSize = state.leases.size * 2 + 64;
}

/** Weakened node objects become unreachable only after a later garbage collection. */
const collectionRetries = 3;

/** Reclaims removed nodes that no JavaScript owner references. */
export function collectState(state: DocumentState): NativeMemoryStats | undefined {
  registry.pending.delete(state);
  state.isCollectionEvicted = false;
  if (!state.raw.collectPinned) return state.raw.collectGarbage?.();
  if (weakenDetachedViews(state)) state.collectionRetries = collectionRetries;
  const pins: number[] = [];
  const { base } = state;
  const end = base + STRIDE;
  for (const lease of state.leases) {
    if (lease.token.isReleased) { state.leases.delete(lease); continue; }
    for (const id of lease.ids) if (id >= base && id < end) pins.push(id - base);
  }
  state.views.forEach((view, local) => { if (view) pins.push(local); });
  for (const local of state.looseViews.keys()) pins.push(local);
  for (const [local, reference] of state.weakViews) {
    if (reference.deref()) pins.push(local);
    else state.weakViews.delete(local);
  }
  const { free, ...stats } = state.raw.collectPinned(Uint32Array.from(pins), rootSlots);
  invalidate(state);
  for (const local of free) releaseSlot(state, local);
  releaseSlotsFrom(state, stats.slots);
  state.looseViewLimit = Math.max(minimumLooseViewLimit, state.looseViews.size * 2);
  if (state.collectionRetries > 0 && state.weakViews.size > 0) {
    state.collectionRetries--;
    scheduleCollection(state);
  }
  return stats;
}

function rawOperation<T = any>(document: NativeDocument, command: string, args: any): T {
  const result = document.op(command, JSON.stringify(args));
  return result === '' || result === undefined ? undefined as T : JSON.parse(result);
}

/** Converts a record's local links to ids. */
function globalRecord(state: DocumentState, record: NativeNodeRecord | null): NativeNodeRecord | null {
  if (!record) return null;
  const { base } = state;
  const link = (local: number | null | undefined): number | null => local == null ? null : base + local;
  return { ...plainRecord(record), id: base + record.id, children: (record.children ?? []).map((child) => base + child), parent: link(record.parent), prev: link(record.prev), next: link(record.next) } as NativeNodeRecord;
}

const parentTypes = new Set(['root', 'tag', 'script', 'style', 'cdata']);
const pointerFields = new Set(['parent', 'parentNode', 'prev', 'previousSibling', 'next', 'nextSibling']);
const idResultCommands = new Set(['select', 'matches', 'uniqueSort', 'traverse', 'clone']);
const scratchCommands = new Set(['select', 'matches', 'uniqueSort', 'serializeArray', 'serialize', 'extractPlan']);
const writeCommands = new Set(['create', 'createNode', 'setNode', 'import', 'insert', 'clone', 'remove', 'removeAttr', 'removeData', 'addClass', 'removeClass', 'toggleClass']);
const attributeFields = new Set(['attribs', 'x-attribsNamespace', 'x-attribsPrefix']);
const targetedAttributeWrites = new Set(['attr', 'removeAttr', 'addClass', 'removeClass', 'toggleClass', 'css']);
/** Writes that only change the records of their own ids. */
const recordOnlyWrites = new Set([...targetedAttributeWrites, 'data', 'removeData']);
const structuralWrites = new Set(['create', 'createNode', 'import', 'insert', 'clone', 'remove', 'html', 'text', 'data', 'removeData']);

/**
 * Routes commands for ids from any document to the arena that owns them.
 * Native adoption moves nodes between arenas; `moveInto` rewrites the ids that
 * live owners hold so node identities survive the move.
 */
export class RoutedDocument implements NativeDocument {
  readonly nodeSpace = registry.space;
  readonly options: CheerioOptions;
  readonly state: DocumentState;
  get raw(): ManagedNativeDocument { return this.state.raw; }

  constructor(document: NativeDocument, options: CheerioOptions = {}) {
    this.options = options;
    this.state = stateFor(document, options);
  }

  /**
   * Sets (or with `null` removes) an attribute, as the `attr` command does,
   * through a typed native call. Attribute objects already handed out are
   * updated in place instead of being read back.
   */
  setAttribute(ids: number[], name: string, value: string | null): void {
    registry.writes++;
    for (const { state, locals } of this.groups(ids)) {
      if (!state.raw.setAttribute) { this.call(state, 'attr', { ids: locals, name, value }); continue; }
      invalidateNodes(state, locals);
      state.raw.setAttribute(locals, name, value);
      for (const local of locals) {
        const target = ((cachedView(state, local) as Record<symbol, { target?: Record<string, string> } | undefined> | undefined)?.[VIEW_ATTRIBUTES])?.target;
        if (!target) continue;
        if (value === null) delete target[name];
        else if (name === '__proto__') Object.defineProperty(target, name, { value, writable: true, enumerable: true, configurable: true });
        else target[name] = value;
      }
    }
  }

  retainNode(id: number): void { this.owner(id); }
  collectGarbage(): NativeMemoryStats | undefined { return collectState(this.state); }
  retainNodeData(id: number, data: object): void { dataEntry(this.owner(id), id).data = data; }
  nodeData(id: number): object | undefined { const state = this.owner(id); return state.data.get(id - state.base)?.data; }
  nodeDataOperation(id: number): (command: string, args: any) => any {
    const entry = dataEntry(this.owner(id), id);
    const options = this.options;
    // Resolve the entry's current arena on each call: the node may have moved.
    return (command, args) => entry.isReleased ? undefined : routedFor(entry.state).operate(command, { ...args, ids: [entry.state.base + entry.local], options });
  }
  localNodeId(local: number): number { return this.state.base + local; }
  rootId(): number { return this.state.base + (this.state.rootLocal ??= this.raw.rootId()); }
  isOwnNode(id: number): boolean { return id >= this.state.base && id < this.state.base + STRIDE; }
  private owner(id: number): DocumentState { return stateIn(this, id); }

  private globals(state: DocumentState, locals: number[]): number[] {
    const { base } = state;
    return locals.map((local) => base + local);
  }

  private groups(ids: number[]): { state: DocumentState; locals: number[] }[] {
    const groups: { state: DocumentState; locals: number[] }[] = [];
    const own = this.state;
    let last: { state: DocumentState; locals: number[] } | undefined;
    for (const id of ids) {
      const state = id >= own.base && id < own.base + STRIDE ? own : exposedStateOf(id);
      if (last?.state === state) last.locals.push(id - state.base);
      else groups.push(last = { state, locals: [id - state.base] });
    }
    return groups;
  }

  private call<T = any>(state: DocumentState, command: string, args: any): T {
    if (command === 'extractPlan' && JSON.stringify(args.plan).includes('innerHTML')) invalidate(state);
    const isWrite = Object.hasOwn(args, 'value') || writeCommands.has(command);
    if (isWrite) {
      registry.writes++;
      const changed = recordOnlyWrites.has(command) ? args.ids ?? [] : command === 'setNode' && attributeFields.has(args.field) ? [args.id] : undefined;
      if (changed) invalidateNodes(state, changed);
      else invalidate(state);
    }
    const result = rawOperation(state.raw, command, { ...args, options: args.options ?? this.options });
    const hasSerializedHtml = command === 'render' || command === 'outerHtml' || (command === 'html' && !isWrite) || (command === 'prop' && (args.name === 'innerHTML' || args.name === 'outerHTML'));
    if (hasSerializedHtml) refreshSerializedNodes(state, args.options ?? this.options);
    if (isWrite) { refreshWrittenAttributes(state, command, args); refreshChildLists(state); scheduleCollectionIfDue(state); }
    return result;
  }

  /** Moves or copies nodes into `target`; returns their local ids there. */
  private moveInto(target: DocumentState, ids: number[], isCopy = false): number[] {
    if (!isCopy) {
      for (const group of this.groups(ids)) {
        if (group.state === target) continue;
        if (!target.raw.adopt) throw new Error('The native addon does not support cross-document adoption. Rebuild the Rust addon.');
        const adopted: { mapping: [number, number][] } = JSON.parse(target.raw.adopt(group.state.raw, group.locals, true));
        rehome(group.state, target, adopted.mapping, ids);
        refreshChildLists(group.state);
        refreshChildLists(target);
        scheduleCollectionIfDue(group.state);
      }
      return ids.map((id) => id - target.base);
    }
    const result: number[] = [];
    for (const group of this.groups(ids)) {
      if (group.state === target) {
        result.push(...this.call<number[]>(target, 'clone', { ids: group.locals, deep: true }));
        continue;
      }
      if (!target.raw.adopt) throw new Error('The native addon does not support cross-document adoption. Rebuild the Rust addon.');
      invalidate(target);
      const adopted: { roots: number[] } = JSON.parse(target.raw.adopt(group.state.raw, group.locals, false));
      result.push(...adopted.roots);
    }
    return result;
  }

  private scratch(command: string, args: any, ids: number[]): any {
    const states = [...new Set(ids.map((id) => this.owner(id)))];
    const scratch = new (requireNative().NativeDocument)('', false, JSON.stringify(args.options ?? this.options));
    const toScratch = new Map<number, number>();
    const fromScratch = new Map<number, number>();
    for (const state of states) {
      const records: NativeNodeRecord[] = JSON.parse(state.raw.exportTree());
      const roots = records.filter((record) => record.parent == null).map((record) => record.id);
      if (!scratch.adopt) throw new Error('The native addon does not support native document copies.');
      const copied: { mapping: [number, number][] } = JSON.parse(scratch.adopt(state.raw, roots, false));
      for (const [local, copy] of copied.mapping) {
        const global = state.base + local;
        toScratch.set(global, copy); fromScratch.set(copy, global);
      }
    }
    const translated = { ...args };
    for (const key of ['ids', 'contexts']) if (Array.isArray(args[key])) translated[key] = args[key].map((id: number) => toScratch.get(id)).filter((id: number | undefined) => id !== undefined);
    if (args.pseudoMatches) translated.pseudoMatches = Object.fromEntries(Object.entries(args.pseudoMatches).map(([key, values]) => [key, (values as number[]).map((id) => toScratch.get(id)).filter((id) => id !== undefined)]));
    const result = rawOperation(scratch, command, { ...translated, options: translated.options ?? this.options });
    return ['select', 'matches', 'uniqueSort'].includes(command) ? (result as number[]).map((id) => fromScratch.get(id)!).filter((id) => id !== undefined) : result;
  }

  private isMixed(groups: { state: DocumentState }[]): boolean {
    return groups.length > 1 && groups.some((group) => group.state !== groups[0].state);
  }

  select(selector: string, contexts?: number[]): number[] {
    const ids = contexts ?? [this.rootId()];
    if (!ids.length) return this.call(this.state, 'select', { selector, contexts: [] });
    const groups = this.groups(ids);
    if (this.isMixed(groups)) return this.scratch('select', { selector, contexts: ids }, ids);
    const group = groups[0];
    const found = group.state === this.state ? group.state.raw.select(selector, group.locals) : this.call<number[]>(group.state, 'select', { selector, contexts: group.locals });
    return this.globals(group.state, found);
  }
  text(ids: number[]): string {
    if (ids.length === 1) {
      const state = this.owner(ids[0]);
      const text = textFromSnapshot(state, ids[0] - state.base);
      if (text !== undefined) return text;
    }
    return this.groups(ids).map((group) => group.state.raw.text(group.locals)).join('');
  }
  innerHtml(id: number): string {
    const state = this.owner(id);
    const local = id - state.base;
    // Serializing template content splices its fragment into the element.
    const isSplicing = recordAt(state, local)?.children?.some((child) => recordAt(state, child)?.type === 'root') ?? false;
    if (isSplicing) invalidate(state);
    const html = state === this.state ? state.raw.innerHtml(local) : this.call<string>(state, 'html', { ids: [local] });
    if (state === this.state) refreshSerializedNodes(state, state.options);
    if (isSplicing && state.hasChildLists && childRefresher) forEachView(state, childRefresher);
    return html;
  }
  outerHtml(ids: number[]): string {
    return this.groups(ids).map((group) => {
      if (group.state !== this.state) return this.call<string>(group.state, 'render', { ids: group.locals });
      const html = group.state.raw.outerHtml(group.locals);
      refreshSerializedNodes(group.state, group.state.options);
      return html;
    }).join('');
  }
  attr(id: number, name: string): string | undefined { const state = this.owner(id); return this.call(state, 'attr', { ids: [id - state.base], name }) ?? undefined; }
  tagName(id: number): string | undefined { const state = this.owner(id); return recordAt(state, id - state.base)?.name; }
  exportTree(): string { return JSON.stringify((JSON.parse(this.raw.exportTree()) as NativeNodeRecord[]).map((record) => globalRecord(this.state, record))); }
  create(html: string, contextId?: number): number[] { return this.operate('create', { html, contextId }); }

  op(command: string, json: string): string { return JSON.stringify(this.operate(command, JSON.parse(json)) ?? null); }

  operate(command: string, args: any): any {
    const options = args.options ?? this.options;
    const hasValue = Object.hasOwn(args, 'value');
    if (command === 'node') { const state = this.owner(args.id); return globalRecord(state, recordAt(state, args.id - state.base)); }
    if (command === 'createNode') return this.state.base + this.call<number>(this.state, command, args);
    if (command === 'import') return this.globals(this.state, this.call(this.state, command, args));
    if (command === 'create') {
      const context = args.contextId == null ? undefined : this.owner(args.contextId);
      const state = context ?? this.state;
      const contextLocal = context ? args.contextId - context.base : undefined;
      if (hasParserHooks(options)) {
        const contextRecord = context ? recordAt(context, contextLocal!) : undefined;
        const children = parsedChildren(args.html, { ...options, ...(contextRecord ? { __contextName: contextRecord.name, __contextNamespace: contextRecord.namespace } : {}) });
        return this.globals(state, this.moveInto(state, children));
      }
      return this.globals(state, this.call(state, command, { ...args, contextId: contextLocal }));
    }
    if (command === 'setNode' || command === 'prop' && hasValue && (args.name === 'children' || args.name === 'childNodes' || pointerFields.has(args.name))) {
      const field = command === 'setNode' ? args.field : args.name;
      let result = null;
      for (const id of command === 'setNode' ? [args.id] : args.ids ?? []) {
        let state = this.owner(id);
        let nodeId = id;
        let value = args.value;
        if (field === 'children' || field === 'childNodes') value = this.moveInto(state, value ?? []);
        else if (pointerFields.has(field) && value != null) {
          const pointer = this.owner(value);
          if (pointer !== state) { const moved = [id]; this.moveInto(pointer, moved); nodeId = moved[0]; state = pointer; }
          value = args.value - pointer.base;
        }
        const local = nodeId - state.base;
        result = this.call(state, command, command === 'setNode' ? { ...args, id: local, value } : { ...args, ids: [local], value });
      }
      return result;
    }
    if (command === 'insert') {
      const targets: number[] = args.targetIds ?? [];
      const nodes: number[] = args.nodeIds ?? [];
      const sameDocument = targets.length > 0 && this.groups([...targets, ...nodes]);
      if (sameDocument && sameDocument.length === 1) {
        // One native call clones for every target but the last, as the loop below does per target.
        const { state } = sameDocument[0];
        const inserted = this.call<number[]>(state, command, { ...args, targetIds: targets.map((id) => id - state.base), nodeIds: nodes.map((id) => id - state.base) });
        return this.globals(state, inserted);
      }
      const result: number[] = [];
      const isBesideTarget = args.position === 'before' || args.position === 'after';
      for (let index = 0; index < targets.length; index++) {
        const target = this.owner(targets[index]);
        const targetLocal = targets[index] - target.base;
        // As the native insert, skip targets that cannot receive nodes before
        // moving any there: the nodes would leave their document for nothing.
        const record = recordAt(target, targetLocal);
        if (!record || !parentTypes.has(record.type) || (isBesideTarget && record.parent == null)) continue;
        const local = this.moveInto(target, nodes, index + 1 < targets.length);
        const inserted = this.call<number[]>(target, command, { ...args, targetIds: [targetLocal], nodeIds: local });
        result.push(...this.globals(target, inserted));
      }
      return result;
    }
    if (command === 'html' && hasValue && hasParserHooks(options)) {
      let result = null;
      for (const id of args.ids ?? []) {
        const state = this.owner(id);
        const local = id - state.base;
        const record = recordAt(state, local);
        if (!record || !parentTypes.has(record.type)) continue;
        const children = parsedChildren(String(args.value), { ...options, __contextName: record.name, __contextNamespace: record.namespace });
        result = this.call(state, 'setNode', { id: local, field: 'children', value: this.moveInto(state, children), options });
      }
      return result;
    }
    if (command === 'contains') {
      const container = args.container ?? args.parent;
      const contained = args.contained ?? args.child;
      const parent = this.owner(container);
      const isSameDocument = contained >= parent.base && contained < parent.base + STRIDE;
      return isSameDocument && this.call(parent, command, { container: container - parent.base, contained: contained - parent.base });
    }
    const ids: number[] = command === 'select' ? args.contexts ?? [this.rootId()] : args.ids ?? [];
    const groups = this.groups(ids);
    if (this.isMixed(groups) && scratchCommands.has(command)) return this.scratch(command, { ...args, options }, ids) ?? null;
    if (command === 'extractPlan') { const group = groups[0]; return this.call(group?.state ?? this.state, command, { ...args, options, ids: group?.locals ?? [] }) ?? null; }
    if (idResultCommands.has(command)) {
      const isSelect = command === 'select';
      if (!groups.length && (isSelect || command === 'matches')) return this.call(this.state, command, { ...args, options, ids: [], ...(isSelect ? { contexts: [] } : {}) });
      const result: number[] = [];
      for (const group of groups) {
        const pseudoMatches = args.pseudoMatches ? Object.fromEntries(Object.entries(args.pseudoMatches as Record<string, number[]>).map(([key, values]) => [key, values.filter((id) => id >= group.state.base && id < group.state.base + STRIDE).map((id) => id - group.state.base)])) : undefined;
        const values = this.call<number[]>(group.state, command, { ...args, options, ids: group.locals, ...(isSelect ? { contexts: group.locals } : {}), ...(pseudoMatches ? { pseudoMatches } : {}) });
        result.push(...this.globals(group.state, values));
      }
      return result;
    }
    if (command === 'render' && !hasValue) {
      const optionsJson = JSON.stringify(options);
      return groups.map((group) => group.state.raw.render ? group.state.raw.render(group.locals, optionsJson) : this.call<string>(group.state, command, { ...args, options, ids: group.locals })).join('');
    }
    if ((command === 'outerHtml' || command === 'text') && !hasValue) return groups.map((group) => this.call<string>(group.state, command, { ...args, options, ids: group.locals })).join('');
    if (command === 'hasClass') return groups.some((group) => this.call<boolean>(group.state, command, { ...args, options, ids: group.locals }));
    if (command === 'serializeArray' || command === 'serialize') return groups.length ? this.call(groups[0].state, command, { ...args, options, ids: groups[0].locals }) : command === 'serializeArray' ? [] : '';
    if (command === 'html') for (const group of groups) invalidate(group.state);
    const isWrite = hasValue || writeCommands.has(command);
    let result = null;
    for (const group of isWrite ? groups : groups.slice(0, 1)) result = this.call(group.state, command, { ...args, options, ids: group.locals });
    return result ?? null;
  }
}

/** Parses `html` into a document of its own, whose children the caller then moves. */
function parsedChildren(html: string, options: CheerioOptions): number[] {
  const parsed = parseNativeDocument(html, options, false) as RoutedDocument;
  exposeState(parsed.state);
  return (parsed.operate('node', { id: parsed.rootId() }) as NativeNodeRecord).children;
}

function dataEntry(state: DocumentState, id: number): DataEntry {
  const local = id - state.base;
  let entry = state.data.get(local);
  if (!entry) state.data.set(local, entry = { state, local });
  return entry;
}

/**
 * Moves the bookkeeping of adopted nodes to their new arena. Live owners'
 * id lists, node objects and data follow the nodes; `ids` is updated too.
 */
function rehome(source: DocumentState, target: DocumentState, mapping: [number, number][], ids: number[]): void {
  registry.writes++;
  invalidate(source); invalidate(target);
  // Owners of the moved ids, including selections of the source's API, now hold ids of the target.
  exposeState(target);
  const moved = new Map<number, number>();
  for (const [oldLocal, newLocal] of mapping) {
    moved.set(source.base + oldLocal, target.base + newLocal);
    const node = uncacheView(source, oldLocal) as Record<symbol, unknown> | undefined;
    if (node) {
      node[VIEW_STATE] = target; node[VIEW_LOCAL] = newLocal; cacheView(target, newLocal, node);
      if (node[VIEW_CHILD_TARGET]) target.hasChildLists = true;
    }
    const entry = source.data.get(oldLocal);
    if (entry) { source.data.delete(oldLocal); entry.state = target; entry.local = newLocal; target.data.set(newLocal, entry); }
    const adapterNode = source.adapterNodes?.[oldLocal] as Record<symbol, unknown> | undefined;
    if (adapterNode) {
      source.adapterNodes![oldLocal] = undefined;
      (target.adapterNodes ??= [])[newLocal] = adapterNode;
      adapterNode[VIEW_STATE] = target; adapterNode[VIEW_LOCAL] = newLocal;
    }
  }
  const rewrite = (list: number[]): boolean => {
    let isTouched = false;
    for (let index = 0; index < list.length; index++) {
      const next = moved.get(list[index]);
      if (next !== undefined) { list[index] = next; isTouched = true; }
    }
    return isTouched;
  };
  // Leases first: `ids` may be a lease's own list, which must still hold the
  // moved ids for the lease to be found.
  for (const lease of [...source.leases]) {
    if (!rewrite(lease.ids)) continue;
    target.leases.add(lease);
    if (!lease.states.includes(target)) lease.states.push(target);
    if (!lease.ids.some((id) => id >= source.base && id < source.base + STRIDE)) {
      source.leases.delete(lease);
      lease.states = lease.states.filter((state) => state !== source);
    }
  }
  rewrite(ids);
}

/** Keeps attribute objects that callers hold in step with native writes. */
function refreshWrittenAttributes(state: DocumentState, command: string, args: any): void {
  if (!hasViews(state)) return;
  let locals: number[] | undefined;
  if (targetedAttributeWrites.has(command)) locals = args.ids ?? [];
  else if (command === 'setNode') { if (!attributeFields.has(args.field)) return; locals = [args.id]; }
  else if (structuralWrites.has(command)) return;
  const refresh = (view: object | undefined): void => { if (view && (view as Record<symbol, unknown>)[VIEW_ATTRIBUTES]) attributeRefresher?.(view); };
  if (locals) for (const local of locals) refresh(cachedView(state, local));
  else forEachView(state, refresh);
}

let attributeRefresher: ((view: object) => void) | undefined;
let childRefresher: ((view: object) => void) | undefined;

/** Registers how node objects re-read their attributes and children after a native write. */
export function onViewRefresh(attributes: (view: object) => void, children: (view: object) => void): void {
  attributeRefresher = attributes;
  childRefresher = children;
}

/** Refills the child arrays of parents whose children a native write changed. */
function refreshChildLists(state: DocumentState): void {
  if (!state.hasChildLists || !childRefresher) return;
  const touched = state.raw.takeTouched?.();
  if (touched === undefined) return;
  if (touched === null) { forEachView(state, childRefresher); return; }
  for (const local of touched) { const view = cachedView(state, local); if (view) childRefresher(view); }
}

export function routeDocument(document: NativeDocument, options: CheerioOptions = {}): NativeDocument {
  return document.nodeSpace === registry.space ? document : new RoutedDocument(document, options);
}

/** The unanchored routed document node objects of `state` use. */
export function routedFor(state: DocumentState): RoutedDocument {
  return state.routed ??= new RoutedDocument(state.raw, state.options);
}

export function sameNodeSpace(first: NativeDocument, second: NativeDocument): boolean {
  return first === second || !!first.nodeSpace && first.nodeSpace === second.nodeSpace;
}

/** Whether ids of `state` belong to this copy of the package; nodes of another copy are foreign objects here. */
export function isLocalState(state: DocumentState): boolean {
  return state.space === registry.space;
}

/** Whether `document` routes ids through this registry. */
export function isRouted(document: NativeDocument): boolean {
  return document.nodeSpace === registry.space;
}
