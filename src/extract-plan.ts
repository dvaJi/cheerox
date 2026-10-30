import type { CheerioOptions, ExtractMap } from './types.js';
import { types } from 'node:util';

export interface ExtractPlanEntry {
  key: string;
  selector: string;
  all: boolean;
  value: { kind: 'property'; name: string } | { kind: 'map'; entries: ExtractPlanEntry[] };
}

export interface ExtractPlan { version: 1; entries: ExtractPlanEntry[] }

// Properties that can be returned as ordinary values. Properties returning DOM
// views stay on the regular API so their identities and document leases survive.
const scalarProperties = new Set([
  'textContent', 'innerText', 'innerHTML', 'outerHTML', 'tagName', 'nodeName',
  'nodeType', 'id', 'class', 'className', 'title', 'href', 'src', 'alt', 'name',
  'value', 'type', 'checked', 'selected', 'disabled', 'multiple', 'readOnly',
  'required', 'hidden', 'open', 'autofocus', 'controls', 'loop', 'muted',
]);

function dataValue(object: object, key: string): { value: unknown } | undefined {
  for (let current: object | null = object; current; current = Object.getPrototypeOf(current)) {
    if (types.isProxy(current)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return 'value' in descriptor ? { value: descriptor.value } : undefined;
  }
  return { value: undefined };
}

/** Compile pure extraction maps. User callbacks and accessors keep JS semantics. */
export function compileExtractPlan(map: ExtractMap, options: CheerioOptions): ExtractPlan | undefined {
  if (options.pseudos || options.treeAdapter || options.Tokenizer || options.xml && typeof options.xml === 'object' && options.xml.Tokenizer) return undefined;
  const ancestors = new Set<object>();
  const compile = (input: unknown): ExtractPlanEntry[] | undefined => {
    if (!input || typeof input !== 'object' || types.isProxy(input) || ancestors.has(input) || ancestors.size >= 64) return undefined;
    for (let current = Object.getPrototypeOf(input); current; current = Object.getPrototypeOf(current)) {
      if (types.isProxy(current)) return undefined;
    }
    ancestors.add(input);
    try {
      const entries: ExtractPlanEntry[] = [];
      for (const key in input) {
        // Cheerio uses an ordinary result object. Its legacy __proto__ setter
        // semantics must execute through the JavaScript path.
        if (key === '__proto__') return undefined;
        const inherited = Object.getOwnPropertyDescriptor(Object.prototype, key);
        if (inherited && (!('value' in inherited) || !inherited.writable)) return undefined;
        const slot = dataValue(input, key);
        if (!slot) return undefined;
        const all = Array.isArray(slot.value);
        if (slot.value && typeof slot.value === 'object' && types.isProxy(slot.value)) return undefined;
        const first = all ? dataValue(slot.value as object, '0') : slot;
        if (!first) return undefined;
        const descriptor = first.value;
        let selector: unknown;
        let value: unknown;
        if (typeof descriptor === 'string') { selector = descriptor; value = 'textContent'; }
        else if (descriptor && typeof descriptor === 'object') {
          if (types.isProxy(descriptor)) return undefined;
          const selectorSlot = dataValue(descriptor, 'selector');
          const valueSlot = dataValue(descriptor, 'value');
          if (!selectorSlot || !valueSlot) return undefined;
          selector = selectorSlot.value;
          value = valueSlot.value ?? 'textContent';
        } else return undefined;
        if (typeof selector !== 'string') return undefined;
        if (typeof value === 'string') {
          if (!scalarProperties.has(value) && !/^(?:data-|aria-).+/.test(value)) return undefined;
          entries.push({ key, selector, all, value: { kind: 'property', name: value } });
        } else {
          const nested = compile(value);
          if (!nested) return undefined;
          entries.push({ key, selector, all, value: { kind: 'map', entries: nested } });
        }
      }
      return entries;
    } finally { ancestors.delete(input); }
  };
  const entries = compile(map);
  return entries && { version: 1, entries };
}

/** JSON omits undefined fields; restore them recursively without changing order. */
export function hydrateExtractResult(result: Record<string, unknown>, entries: ExtractPlanEntry[]): void {
  const values = entries.map((entry) => Object.hasOwn(result, entry.key) ? result[entry.key] : entry.all ? [] : undefined);
  for (const entry of entries) delete result[entry.key];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    Object.defineProperty(result, entry.key, { value: values[index], enumerable: true, configurable: true, writable: true });
    if (entry.value.kind !== 'map') continue;
    const nested = result[entry.key];
    for (const value of entry.all && Array.isArray(nested) ? nested : [nested]) {
      if (value && typeof value === 'object' && !Array.isArray(value)) hydrateExtractResult(value as Record<string, unknown>, entry.value.entries);
    }
  }
}
