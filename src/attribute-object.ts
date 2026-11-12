/**
 * Attribute objects: real objects whose enumerable keys are shared accessor
 * pairs, so reads cost what plain-object reads do while direct writes still
 * reach the node's native record. Values live in one hidden metadata object
 * per attribute object (`values`), attached under a non-enumerable symbol;
 * deep equality and JSON therefore see only the attribute keys. This module
 * is dependency-free: `nodes.ts` and `snapshot.ts` both use it.
 */

export interface AttributeMeta { view: unknown; generation: number; state: unknown; values: Record<string, any>; write?: (view: unknown, attributes: AttributeObject, key: string, value: unknown) => void }
export const ATTR_META: unique symbol = Symbol.for('cheerox.attribs.meta') as any;
export interface AttributeObject { [key: string]: any; [ATTR_META]?: AttributeMeta }

const accessorPairs = new Map<string, PropertyDescriptor>();

/** One shared accessor pair per attribute name; `this` is the attribute object. */
function accessorPairFor(key: string): PropertyDescriptor {
  let pair = accessorPairs.get(key);
  if (pair === undefined) {
    pair = {
      get(this: AttributeObject) { return this[ATTR_META]!.values[key]; },
      set(this: AttributeObject, value: unknown) { const meta = this[ATTR_META]!; meta.write?.(meta.view, this, key, value); },
      enumerable: true, configurable: true,
    };
    accessorPairs.set(key, pair);
  }
  return pair;
}

/** Defines a shared accessor for `key` when the object has none yet. */
export function defineAttributeAccessor(attributes: AttributeObject, key: string): void {
  if (!Object.hasOwn(attributes, key)) Object.defineProperty(attributes, key, accessorPairFor(key));
}

/**
 * Defines an attribute key with its stored value. `__proto__` must stay a
 * plain data property on both layers: an accessor there would shadow the
 * prototype's setter, reflection expects a value descriptor, and assigning
 * `values.__proto__` would mutate the store's prototype instead of setting a
 * key.
 */
export function defineAttributeKey(attributes: AttributeObject, key: string, value: unknown): void {
  const values = attributes[ATTR_META]!.values;
  if (key === '__proto__') {
    Object.defineProperty(attributes, key, { value, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(values, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    defineAttributeAccessor(attributes, key);
    values[key] = value;
  }
}

/** Attaches the metadata that accessor setters need to reach the record. */
export function setAttributeMeta(attributes: AttributeObject, meta: AttributeMeta): void {
  Object.defineProperty(attributes, ATTR_META, { value: meta, enumerable: false, writable: true, configurable: true });
}

/** Assigns or removes an attribute from the outside (the router's fast native paths). */
export function attributeAssign(attributes: AttributeObject, name: string, value: string | null): void {
  const meta = attributes[ATTR_META];
  if (!meta) return;
  if (value === null) {
    delete attributes[name];
    // `delete values.__proto__` on the store object is safe only for an own
    // data property; `__proto__` keys are defined exactly that way.
    delete meta.values[name];
  } else {
    defineAttributeKey(attributes, name, value);
  }
  meta.generation = -1;
}
