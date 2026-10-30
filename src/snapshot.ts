import { decodeString } from './codec.js';
import type { NativeNodeRecord } from './native.js';

/**
 * The compact record copy returned by `NativeDocument.snapshot()`: the
 * lengths of the node, child, attribute and string lists, whether any string
 * holds codec escapes, then the lists.
 */
export interface NativeSnapshot {
  data: Uint32Array;
  text: string;
}
const HEADER = 5;

const STRIDE = 15;
const ABSENT = 0xffffffff;
const HAS_START_INDEX = 1;
const HAS_END_INDEX = 2;
const HAS_NAMESPACE = 4;
const EMPTY_ATTRIBUTE_MAPS = 8;
const OPAQUE = 16;
const RELEASED = 32;
const noChildren: number[] = Object.freeze([]) as unknown as number[];
const noAttributes: Record<string, string> = Object.freeze({}) as Record<string, string>;

/**
 * A record read from a snapshot. It stores only its position; fields decode
 * on read, and strings and lists are kept once decoded. Every instance has
 * the same fields, so reads stay monomorphic. Absent fields read `undefined`.
 */
class SnapshotRecord {
  private decodedData: string | undefined;
  private decodedAttributes: Record<string, string> | undefined;
  private decodedChildren: number[] | undefined;

  constructor(private readonly snapshot: NodeSnapshot, readonly id: number, private readonly base: number) {
    this.decodedData = undefined;
    this.decodedAttributes = undefined;
    this.decodedChildren = undefined;
  }

  get type(): string { return this.snapshot.name(this.snapshot.nodes[this.base]); }
  get name(): string | undefined { const name = this.snapshot.nodes[this.base + 6]; return name ? this.snapshot.name(name - 1) : undefined; }
  get data(): string | undefined {
    if (this.decodedData !== undefined) return this.decodedData;
    const data = this.snapshot.nodes[this.base + 7];
    return data ? this.decodedData = this.snapshot.string(data - 1) : undefined;
  }
  get parent(): number | null { const parent = this.snapshot.nodes[this.base + 1]; return parent ? parent - 1 : null; }
  get prev(): number | null { const prev = this.snapshot.nodes[this.base + 2]; return prev ? prev - 1 : null; }
  get next(): number | null { const next = this.snapshot.nodes[this.base + 3]; return next ? next - 1 : null; }
  get startIndex(): number | null | undefined { return this.index(HAS_START_INDEX, 11); }
  get endIndex(): number | null | undefined { return this.index(HAS_END_INDEX, 12); }
  get namespace(): string | undefined { const nodes = this.snapshot.nodes; return nodes[this.base + 10] & HAS_NAMESPACE ? this.snapshot.name(nodes[this.base + 13]) : undefined; }
  get attribsNamespace(): Record<string, string> | undefined { return this.snapshot.nodes[this.base + 10] & EMPTY_ATTRIBUTE_MAPS ? {} : undefined; }
  get attribsPrefix(): Record<string, string> | undefined { return this.snapshot.nodes[this.base + 10] & EMPTY_ATTRIBUTE_MAPS ? {} : undefined; }
  get attribs(): Record<string, string> { return this.decodedAttributes ??= this.snapshot.attributesOf(this.id); }
  get children(): number[] { return this.decodedChildren ??= this.snapshot.childrenOf(this.id); }

  private index(flag: number, offset: number): number | null | undefined {
    const nodes = this.snapshot.nodes;
    if (!(nodes[this.base + 10] & flag)) return undefined;
    const value = nodes[this.base + offset];
    return value === ABSENT ? null : value;
  }
}

/** Snapshot records extended with fields stored as JSON, which are rare. */
const recordFields = ['type', 'name', 'data', 'parent', 'prev', 'next', 'startIndex', 'endIndex', 'namespace', 'attribsNamespace', 'attribsPrefix', 'attribs', 'children'] as const;

/** A plain copy of a record, for callers that spread or serialize it. */
export function plainRecord(record: NativeNodeRecord): NativeNodeRecord {
  if (!(record instanceof SnapshotRecord)) return record;
  const copy: Record<string, unknown> = { id: record.id };
  for (const field of recordFields) { const value = (record as any)[field]; if (value !== undefined) copy[field] = value; }
  for (const key of Object.keys(record)) if (!key.startsWith('decoded') && key !== 'snapshot' && key !== 'base' && key !== 'id') copy[key] = (record as any)[key];
  return copy as NativeNodeRecord;
}

/** Decodes node records from a snapshot on demand, exactly as `node()` returns them. */
export class NodeSnapshot {
  readonly size: number;
  readonly nodes: Uint32Array;
  private readonly children: Uint32Array;
  private readonly attributes: Uint32Array;
  private readonly strings: Uint32Array;
  private readonly text: string;
  private readonly isEncoded: boolean;
  private readonly names: (string | undefined)[] = [];
  /** Per interned type: 1 for element types, 2 for root, 3 for text, 0 otherwise. */
  private readonly typeKinds: (number | undefined)[] = [];
  /** Node object constructors by interned type, resolved once per snapshot. */
  viewConstructors: unknown = undefined;
  /** Text nodes too large for the arrays, read individually while this snapshot is current. */
  readonly largeTexts = new Map<number, string>();

  constructor(raw: NativeSnapshot) {
    const { data } = raw;
    const childrenStart = HEADER + data[0];
    const attributesStart = childrenStart + data[1];
    const stringsStart = attributesStart + data[2];
    this.text = raw.text;
    this.isEncoded = data[4] === 1;
    this.nodes = data.subarray(HEADER, childrenStart);
    this.children = data.subarray(childrenStart, attributesStart);
    this.attributes = data.subarray(attributesStart, stringsStart);
    this.strings = data.subarray(stringsStart, stringsStart + data[3]);
    this.size = this.nodes.length / STRIDE;
  }

  /** The record, `null` for a released node, or `undefined` when it must be read individually. */
  record(local: number): NativeNodeRecord | null | undefined {
    if (local >= this.size) return undefined;
    const base = local * STRIDE;
    const flags = this.nodes[base + 10];
    if (flags & RELEASED) return null;
    if (flags & OPAQUE) return undefined;
    const record = new SnapshotRecord(this, local, base);
    const extras = this.nodes[base + 14];
    if (extras) {
      // Fields stored as JSON, such as foreign attribute namespaces, shadow the decoded getters.
      const fields = JSON.parse(this.string(extras - 1));
      for (const key of Object.keys(fields)) Object.defineProperty(record, key, { value: fields[key], writable: true, enumerable: true, configurable: true });
    }
    return record as unknown as NativeNodeRecord;
  }

  /** Whether a node's fields all live in the arrays, so callers may read them without a record. */
  isPlain(local: number): boolean {
    if (local >= this.size) return false;
    const base = local * STRIDE;
    return (this.nodes[base + 10] & (OPAQUE | RELEASED)) === 0 && this.nodes[base + 14] === 0;
  }

  typeOf(local: number): string {
    return this.name(this.nodes[local * STRIDE]);
  }

  nameOf(local: number): string | undefined {
    const name = this.nodes[local * STRIDE + 6];
    return name ? this.name(name - 1) : undefined;
  }

  dataOf(local: number): string | undefined {
    const data = this.nodes[local * STRIDE + 7];
    return data ? this.string(data - 1) : undefined;
  }

  /** The parent, previous or next sibling (`offset` 1, 2 or 3), or `null`. */
  linkOf(local: number, offset: number): number | null {
    const link = this.nodes[local * STRIDE + offset];
    return link ? link - 1 : null;
  }

  namespaceOf(local: number): string | undefined {
    const base = local * STRIDE;
    return this.nodes[base + 10] & HAS_NAMESPACE ? this.name(this.nodes[base + 13]) : undefined;
  }

  /** A node's attributes as parse5 attribute objects; plain nodes have no namespaced ones. */
  attributeObjects(local: number): { name: string; value: string }[] {
    const base = local * STRIDE;
    const count = this.nodes[base + 9];
    const first = this.nodes[base + 8];
    const attributes = this.attributes;
    const result: { name: string; value: string }[] = new Array(count);
    for (let index = 0; index < count; index++) {
      const pair = (first + index) * 2;
      result[index] = { name: this.name(attributes[pair]), value: this.string(attributes[pair + 1]) };
    }
    return result;
  }

  /** Copies a node's attributes onto `target`, in order. */
  copyAttributes(local: number, target: Record<string, string>): void {
    const base = local * STRIDE;
    const count = this.nodes[base + 9];
    const first = this.nodes[base + 8];
    const attributes = this.attributes;
    for (let index = 0; index < count; index++) {
      const pair = (first + index) * 2;
      const name = this.name(attributes[pair]);
      const value = this.string(attributes[pair + 1]);
      if (name === '__proto__') Object.defineProperty(target, name, { value, writable: true, enumerable: true, configurable: true });
      else target[name] = value;
    }
  }

  /** The flat child id list; a node's children start at `childStart(local)`. */
  get childIds(): Uint32Array { return this.children; }

  childStart(local: number): number {
    return this.nodes[local * STRIDE + 4];
  }

  /** Whether a node is an element: a tag, script or style. */
  isElementAt(local: number): boolean {
    return this.typeKind(local) === 1;
  }

  isRootAt(local: number): boolean {
    return this.typeKind(local) === 2;
  }

  isTextAt(local: number): boolean {
    return this.typeKind(local) === 3;
  }

  /** Whether a node's record adds fields stored as JSON, such as source locations. */
  hasExtraFields(local: number): boolean {
    return this.nodes[local * STRIDE + 14] !== 0;
  }

  /** Whether the slot holds a node, rather than one a collection released. */
  isPresent(local: number): boolean {
    return local < this.size && (this.nodes[local * STRIDE + 10] & RELEASED) === 0;
  }

  private typeKind(local: number): number {
    const reference = this.nodes[local * STRIDE];
    let kind = this.typeKinds[reference];
    if (kind === undefined) {
      const type = this.name(reference);
      kind = this.typeKinds[reference] = type === 'tag' || type === 'script' || type === 'style' ? 1 : type === 'root' ? 2 : type === 'text' ? 3 : 0;
    }
    return kind;
  }

  /** The interned reference of a node's type, comparable across nodes of this snapshot. */
  typeReference(local: number): number {
    return this.nodes[local * STRIDE];
  }

  /** Child ids without materializing the record. */
  childCount(local: number): number {
    return this.nodes[local * STRIDE + 5];
  }

  childAt(local: number, index: number): number {
    return this.children[this.nodes[local * STRIDE + 4] + index];
  }

  childrenOf(local: number): number[] {
    const base = local * STRIDE;
    const count = this.nodes[base + 5];
    if (count === 0) return noChildren;
    const first = this.nodes[base + 4];
    return Array.from(this.children.subarray(first, first + count));
  }

  attributesOf(local: number): Record<string, string> {
    const base = local * STRIDE;
    const count = this.nodes[base + 9];
    if (count === 0) return noAttributes;
    const first = this.nodes[base + 8];
    const attributes = this.attributes;
    const result: Record<string, string> = {};
    for (let index = 0; index < count; index++) {
      const pair = (first + index) * 2;
      const name = this.name(attributes[pair]);
      const value = this.string(attributes[pair + 1]);
      if (name === '__proto__') Object.defineProperty(result, name, { value, writable: true, enumerable: true, configurable: true });
      else result[name] = value;
    }
    return result;
  }

  /** One attribute's value, without decoding the rest. */
  attributeValue(local: number, name: string): string | undefined {
    const base = local * STRIDE;
    const count = this.nodes[base + 9];
    const first = this.nodes[base + 8];
    const attributes = this.attributes;
    // A repeated name keeps its last value, as decoded attribute maps do.
    for (let index = count - 1; index >= 0; index--) {
      const pair = (first + index) * 2;
      if (this.name(attributes[pair]) === name) return this.string(attributes[pair + 1]);
    }
    return undefined;
  }

  string(reference: number): string {
    const strings = this.strings;
    const value = this.text.slice(strings[reference * 2], strings[reference * 2 + 1]);
    return this.isEncoded ? decodeString(value) : value;
  }

  /** Names repeat across nodes, so each decodes once. */
  name(reference: number): string {
    return this.names[reference] ??= this.string(reference);
  }
}
