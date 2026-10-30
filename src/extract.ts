import { Cheerio, nativeExtractionMethods } from './selection.js';
import { types } from 'node:util';
import { compileExtractPlan, hydrateExtractResult } from './extract-plan.js';
import { decodeJson } from './codec.js';
import { DOCUMENT, writeCount } from './router.js';
import type { AnyNode, CheerioOptions, Element, ExtractMap, ExtractedMap, ExtractDescriptor } from './types.js';

type ExtractPlan = NonNullable<ReturnType<typeof compileExtractPlan>>;

export interface ExtractMethods<T = AnyNode> {
  extract<M extends ExtractMap>(map: M): ExtractedMap<M>;
}

function plainKeys(map: ExtractMap): string[] | undefined {
  return !types.isProxy(map) && (Object.getPrototypeOf(map) === Object.prototype || Object.getPrototypeOf(map) === null) ? Object.keys(map) : undefined;
}
function nativePrefix(scope: Cheerio<AnyNode>, map: ExtractMap, keys: string[] | undefined, key: string): { keys: string[]; values: Record<string, unknown> } | undefined {
  if (!keys || !hasNativeExtraction(scope)) return undefined;
  const prefix = prefixPlan(map, keys, key, scope.options);
  // A single scalar entry costs one selector call and one property call; the
  // native plan also avoids constructing an intermediate selection for each.
  if (!prefix) return undefined;
  return { keys: prefix.names, values: runPlan(scope, prefix.plan) };
}

/** The native plan for the longest run of entries from `key` on that compile to one. */
function prefixPlan(map: ExtractMap, keys: string[], key: string, options: CheerioOptions): { names: string[]; plan: ExtractPlan } | undefined {
  const prefix: ExtractMap = Object.create(null);
  let plan: ExtractPlan | undefined;
  for (let position = keys.indexOf(key); position < keys.length; position++) {
    const name = keys[position];
    const slot = Object.getOwnPropertyDescriptor(map, name);
    if (!slot || !slot.enumerable || !('value' in slot)) break;
    Object.defineProperty(prefix, name, { value: slot.value, enumerable: true, configurable: true });
    const compiled = compileExtractPlan(prefix, options);
    if (!compiled) { delete prefix[name]; break; }
    plan = compiled;
  }
  return plan ? { names: Object.keys(prefix), plan } : undefined;
}

function hasNativeExtraction(scope: Cheerio<AnyNode>): boolean {
  return scope._make === nativeExtractionMethods.make && scope._findBySelector === nativeExtractionMethods.find && scope.prop === nativeExtractionMethods.prop && scope.extract === nativeExtractionMethods.extract;
}

/** Descriptor callbacks stay in JavaScript; matching and properties use Rust. */
export function extract<M extends ExtractMap>(this: Cheerio<AnyNode>, map: M): ExtractedMap<M> {
  const result: Record<string, unknown> = {};
  const keys = plainKeys(map);
  const processed = new Set<string>();
  for (const key in map) {
    if (processed.has(key)) continue;
    const prefix = Object.getPrototypeOf(result) === Object.prototype ? nativePrefix(this, map, keys, key) : undefined;
    if (prefix) {
      for (const name of prefix.keys) { Object.defineProperty(result, name, { value: prefix.values[name], enumerable: true, configurable: true, writable: true }); processed.add(name); }
      continue;
    }
    const entry = map[key];
    const all = Array.isArray(entry);
    const descriptor = (all ? entry[0] : entry) as string | ExtractDescriptor;
    const selector = typeof descriptor === 'string' ? descriptor : descriptor.selector;
    const value = typeof descriptor === 'string' ? 'textContent' : descriptor.value ?? 'textContent';
    const selection = this._findBySelector(selector, all ? Infinity : 1);
    const rows = typeof value === 'object' ? nativeRows(this, key, all, selector, value) : undefined;
    const read = (index: number) => {
      if (typeof value === 'function') return value(selection[index] as Element, key, result);
      const scope = this._make === nativeExtractionMethods.make
        ? this._fromIds([selection.ids[index]])
        : this._make(selection[index]);
      if (typeof value === 'string') return scope.prop(value);
      return rows ? completeRow(scope, value, rows, index) : scope.extract(value);
    };
    let extracted: unknown;
    if (all) {
      const values: unknown[] = [];
      for (let index = 0; index < selection.length; index += 1) {
        const value = read(index);
        if (value != null) values.push(...(Array.isArray(value) ? value : [value]));
      }
      extracted = values;
    } else {
      extracted = selection.length ? read(0) : undefined;
    }
    result[key] = extracted;
  }
  return result as ExtractedMap<M>;
}

/** Fields of each row that the native engine extracts, for every row in one call. */
interface NativeRows { keys: Set<string>; rows: Record<string, unknown>[]; writes: number }

/**
 * For a nested map with callbacks, extracts the fields the native engine can
 * for every matched element in one call, instead of one call per element;
 * the remaining fields are then filled in map order, so each callback sees
 * exactly the fields before it, as in Cheerio.
 */
function nativeRows(scope: Cheerio<AnyNode>, key: string, all: boolean, selector: string, map: ExtractMap): NativeRows | undefined {
  if (!hasNativeExtraction(scope)) return undefined;
  const planned = rowsPlan(key, all, selector, map, scope.options);
  if (!planned) return undefined;
  const writes = writeCount();
  const extracted = runPlan(scope, planned.plan)[key];
  const rows = (all ? extracted : extracted === undefined ? [] : [extracted]) as Record<string, unknown>[];
  return Array.isArray(rows) ? { keys: planned.nativeKeys, rows, writes } : undefined;
}

/** The native plan for the fields of `map` that compile to one, when only some do. */
function rowsPlan(key: string, all: boolean, selector: string, map: ExtractMap, options: CheerioOptions): { nativeKeys: Set<string>; plan: ExtractPlan } | undefined {
  const keys = plainKeys(map);
  if (!keys) return undefined;
  const subset: ExtractMap = Object.create(null);
  const nativeKeys = new Set<string>();
  for (const name of keys) {
    const slot = Object.getOwnPropertyDescriptor(map, name);
    if (!slot || !slot.enumerable || !('value' in slot)) continue;
    const single: ExtractMap = Object.create(null);
    Object.defineProperty(single, name, { value: slot.value, enumerable: true, configurable: true });
    if (!compileExtractPlan(single, options)) continue;
    Object.defineProperty(subset, name, { value: slot.value, enumerable: true, configurable: true });
    nativeKeys.add(name);
  }
  if (!nativeKeys.size || nativeKeys.size === keys.length) return undefined;
  const outer: ExtractMap = Object.create(null);
  Object.defineProperty(outer, key, { value: all ? [{ selector, value: subset }] : { selector, value: subset }, enumerable: true, configurable: true });
  const plan = compileExtractPlan(outer, options);
  return plan ? { nativeKeys, plan } : undefined;
}

/**
 * The plans a walk of `map` from a document's root runs first, in order, so
 * a batch can run them on its parsing threads. Callbacks may change the
 * document, so later plans of the walk stay on the calling thread.
 */
export function rootExtractPlans(map: ExtractMap, options: CheerioOptions): ExtractPlan[] {
  // Reading a map ahead of the walk must not run code the walk would run in
  // a different order, and a malformed map fails later with the walk's own error.
  if (!isPlainData(map, 0) || hasInheritedEntryFields()) return [];
  try { return collectRootExtractPlans(map, options); } catch { return []; }
}

/** Whether reading `value` and everything it holds runs no code: no proxies, accessors or class instances. */
function isPlainData(value: unknown, depth: number): boolean {
  if (typeof value !== 'object' || value === null) return true;
  if (depth > 32 || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    const slot = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in slot) || !isPlainData(slot.value, depth + 1)) return false;
  }
  return true;
}

function hasInheritedEntryFields(): boolean {
  return 'selector' in Object.prototype || 'value' in Object.prototype || '0' in Array.prototype;
}

function collectRootExtractPlans(map: ExtractMap, options: CheerioOptions): ExtractPlan[] {
  const plans: ExtractPlan[] = [];
  const keys = plainKeys(map);
  const processed = new Set<string>();
  for (const key in map) {
    if (processed.has(key)) continue;
    const prefix = keys ? prefixPlan(map, keys, key, options) : undefined;
    if (prefix) {
      for (const name of prefix.names) processed.add(name);
      plans.push(prefix.plan);
      continue;
    }
    const entry = map[key];
    const all = Array.isArray(entry);
    const descriptor = (all ? entry[0] : entry) as string | ExtractDescriptor;
    const value = typeof descriptor === 'string' ? 'textContent' : descriptor.value ?? 'textContent';
    if (typeof value !== 'object' || value === null) continue;
    const planned = rowsPlan(key, all, typeof descriptor === 'string' ? descriptor : descriptor.selector, value, options);
    if (planned) plans.push(planned.plan);
  }
  return plans.filter((plan) => !JSON.stringify(plan).includes('innerHTML'));
}

/** Results of root plans a batch ran while parsing, valid while no document changes. */
const preparedPlans = new WeakMap<object, { writes: number; results: Map<string, string> }>();

export function prepareExtractPlans(document: object, plans: ExtractPlan[], results: (string | null)[] | null | undefined): void {
  if (!results) return;
  const prepared = new Map<string, string>();
  for (let index = 0; index < plans.length; index++) {
    const result = results[index];
    if (typeof result === 'string') prepared.set(JSON.stringify(plans[index]), decodeJson(result));
  }
  preparedPlans.set(document, { writes: writeCount(), results: prepared });
}

export function releaseExtractPlans(document: object): void {
  preparedPlans.delete(document);
}

function runPlan(scope: Cheerio<AnyNode>, plan: ExtractPlan): Record<string, unknown> {
  const document = scope[DOCUMENT] as { rootId(): number };
  const prepared = preparedPlans.get(document);
  const isRoot = prepared !== undefined && prepared.writes === writeCount() && scope.ids.length === 1 && scope.ids[0] === document.rootId();
  const result = isRoot ? prepared.results.get(JSON.stringify(plan)) : undefined;
  const values = result !== undefined ? JSON.parse(result) as Record<string, unknown> : scope.op<Record<string, unknown>>('extractPlan', { ids: scope.ids, plan });
  hydrateExtractResult(values, plan.entries);
  return values;
}

/**
 * Builds row `index` of a nested map from its native fields and the scope's
 * JavaScript fields. Native fields extracted before a callback changed any
 * document are extracted again, as extracting row by row would see them.
 */
function completeRow(scope: Cheerio<AnyNode>, map: ExtractMap, rows: NativeRows, index: number): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const native = rows.rows[index] ?? {};
  for (const name in map) {
    if (rows.keys.has(name) && writeCount() === rows.writes) { row[name] = native[name]; continue; }
    const entry: ExtractMap = Object.create(null);
    Object.defineProperty(entry, name, { value: map[name], enumerable: true, configurable: true });
    fillEntries(scope, entry, row);
  }
  return row;
}

/** Extracts `map`'s entries into `result`, which callbacks receive as built so far. */
function fillEntries(scope: Cheerio<AnyNode>, map: ExtractMap, result: Record<string, unknown>): void {
  for (const key in map) {
    const entry = map[key];
    const all = Array.isArray(entry);
    const descriptor = (all ? entry[0] : entry) as string | ExtractDescriptor;
    const selector = typeof descriptor === 'string' ? descriptor : descriptor.selector;
    const value = typeof descriptor === 'string' ? 'textContent' : descriptor.value ?? 'textContent';
    const selection = scope._findBySelector(selector, all ? Infinity : 1);
    const read = (index: number) => {
      if (typeof value === 'function') return value(selection[index] as Element, key, result);
      const child = scope._make === nativeExtractionMethods.make ? scope._fromIds([selection.ids[index]]) : scope._make(selection[index]);
      return typeof value === 'string' ? child.prop(value) : child.extract(value);
    };
    if (all) {
      const values: unknown[] = [];
      for (let index = 0; index < selection.length; index += 1) {
        const extracted = read(index);
        if (extracted != null) values.push(...(Array.isArray(extracted) ? extracted : [extracted]));
      }
      result[key] = values;
    } else result[key] = selection.length ? read(0) : undefined;
  }
}

export function installExtract(CheerioClass: { prototype: object }): void {
  Object.assign(CheerioClass.prototype, { extract });
}

/** Async batch fallback preserves callback values/order while yielding between visits. */
export async function extractCooperatively<M extends ExtractMap>(selection: Cheerio<AnyNode>, map: M): Promise<{ value: ExtractedMap<M> }> {
  let deadline = performance.now() + 4;
  let visits = 0;
  const checkpoint = async () => {
    if (++visits % 32 || performance.now() < deadline) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    deadline = performance.now() + 4;
  };
  const walk = async (scope: Cheerio<AnyNode>, descriptors: ExtractMap): Promise<{ value: Record<string, unknown> }> => {
    const result: Record<string, unknown> = {};
    const keys = plainKeys(descriptors);
    const processed = new Set<string>();
    for (const key in descriptors) {
      if (processed.has(key)) continue;
      const prefix = Object.getPrototypeOf(result) === Object.prototype ? nativePrefix(scope, descriptors, keys, key) : undefined;
      if (prefix) {
        for (const name of prefix.keys) { Object.defineProperty(result, name, { value: prefix.values[name], enumerable: true, configurable: true, writable: true }); processed.add(name); }
        continue;
      }
      const entry = descriptors[key];
      const all = Array.isArray(entry);
      const descriptor = (all ? entry[0] : entry) as string | ExtractDescriptor;
      const selector = typeof descriptor === 'string' ? descriptor : descriptor.selector;
      const value = typeof descriptor === 'string' ? 'textContent' : descriptor.value ?? 'textContent';
      const found = scope._findBySelector(selector, all ? Infinity : 1);
      const rows = typeof value === 'object' ? nativeRows(scope, key, all, selector, value) : undefined;
      const output: unknown[] = [];
      let single: unknown;
      const count = all ? found.length : Math.min(found.length, 1);
      for (let index = 0; index < count; index++) {
        await checkpoint();
        // Callback return values, including Promise objects, remain ordinary
        // values just as in synchronous Cheerio.extract().
        let extracted: unknown;
        if (typeof value === 'function') extracted = value(found[index] as Element, key, result);
        else {
          const child = scope._make === nativeExtractionMethods.make
            ? scope._fromIds([found.ids[index]])
            : scope._make(found[index]);
          extracted = typeof value === 'string' ? child.prop(value)
            : rows ? completeRow(child, value, rows, index)
            : child.extract === nativeExtractionMethods.extract ? (await walk(child, value)).value : child.extract(value);
        }
        if (all) { if (extracted != null) output.push(...(Array.isArray(extracted) ? extracted : [extracted])); }
        else single = extracted;
      }
      result[key] = all ? output : single;
    }
    return { value: result };
  };
  return await walk(selection, map) as { value: ExtractedMap<M> };
}
