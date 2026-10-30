import { requireNative } from './native.js';
import { getNode, importNodes, nodeBinding, operation, cloneNode } from './nodes.js';
import { routeDocument } from './router.js';
import type * as Shape from './types.js';

export const ElementType = Object.freeze({ Root: 'root', Text: 'text', Directive: 'directive', Comment: 'comment', Script: 'script', Style: 'style', Tag: 'tag', CDATA: 'cdata', Doctype: 'doctype' } as typeof Shape.ElementType);

function initialize<T extends Node>(node: T, type: string, fields: Record<string, unknown>, children: readonly Shape.AnyNode[] = []): T {
  const document = routeDocument(new (requireNative().NativeDocument)('', false));
  const id = operation<number>(document, 'createNode', { type, ...fields });
  if (children.length) operation(document, 'setNode', { id, field: 'children', value: importNodes(document, children) });
  return getNode(document, id, node) as unknown as T;
}

/** DOM constructors backed by native storage, also shared across ESM/CJS views. */
export abstract class Node {
  static [Symbol.hasInstance](value: unknown): boolean {
    const binding = nodeBinding(value);
    if (!binding) return Function.prototype[Symbol.hasInstance].call(this, value);
    const type = (value as Shape.AnyNode).type;
    switch (this.name) {
      case 'Node': return true;
      case 'DataNode': return ['text', 'comment', 'directive'].includes(type);
      case 'NodeWithChildren': return ['root', 'tag', 'script', 'style', 'cdata'].includes(type);
      case 'Element': return ['tag', 'script', 'style'].includes(type);
      case 'Document': return type === 'root';
      case 'CDATA': return type === 'cdata';
      case 'Text': return type === 'text';
      case 'Comment': return type === 'comment';
      case 'ProcessingInstruction': return type === 'directive';
      default: return Function.prototype[Symbol.hasInstance].call(this, value);
    }
  }
}
export interface Node extends Shape.Node {}
export abstract class DataNode extends Node {}
export interface DataNode extends Shape.DataNode {}
export abstract class NodeWithChildren extends Node {}
export interface NodeWithChildren extends Shape.NodeWithChildren {}
export class Text extends DataNode { declare readonly nodeType: 3; declare type: Shape.Text['type']; constructor(data: string) { super(); return initialize(this, 'text', { data }); } }
export interface Text extends Shape.Text {}
export class Comment extends DataNode { declare readonly nodeType: 8; declare type: Shape.Comment['type']; constructor(data: string) { super(); return initialize(this, 'comment', { data }); } }
export interface Comment extends Shape.Comment {}
export class ProcessingInstruction extends DataNode { declare readonly nodeType: 1; declare type: Shape.ProcessingInstruction['type']; constructor(name: string, data: string) { super(); return initialize(this, 'directive', { name, data }); } }
export interface ProcessingInstruction extends Shape.ProcessingInstruction {}
export class Document extends NodeWithChildren { declare readonly nodeType: 9; declare type: Shape.Document['type']; constructor(children: Shape.ChildNode[]) { super(); return initialize(this, 'root', {}, children); } }
export interface Document extends Shape.Document {}
export class CDATA extends NodeWithChildren { declare readonly nodeType: 4; declare type: Shape.CDATA['type']; constructor(children: Shape.ChildNode[]) { super(); return initialize(this, 'cdata', {}, children); } }
export interface CDATA extends Shape.CDATA {}
export class Element extends NodeWithChildren { declare readonly nodeType: 1; declare type: Shape.Element['type']; declare sourceCodeLocation?: Shape.TagSourceCodeLocation | null;
  constructor(name: string, attribs: Record<string, string>, children: Shape.ChildNode[] = [], type?: Shape.Element['type']) {
    super(); return initialize(this, type ?? (name === 'script' || name === 'style' ? name : 'tag'), { name, attribs }, children);
  }
}
export interface Element extends Shape.Element {}

/** @internal */
export function nodePrototype(type: string): object {
  return ({ root: Document, text: Text, comment: Comment, directive: ProcessingInstruction, cdata: CDATA, tag: Element, script: Element, style: Element }[type] ?? Node).prototype;
}
export const isTag = (node: Shape.Node): node is Shape.Element => ['tag', 'script', 'style'].includes(node.type);
export const isText = (node: Shape.Node): node is Shape.Text => node.type === 'text';
export const isComment = (node: Shape.Node): node is Shape.Comment => node.type === 'comment';
export const isDirective = (node: Shape.Node): node is Shape.ProcessingInstruction => node.type === 'directive';
export const isDocument = (node: Shape.Node): node is Shape.Document => node.type === 'root';
export const isCDATA = (node: Shape.Node): node is Shape.CDATA => node.type === 'cdata';
export const hasChildren = (node: Shape.Node): node is Shape.NodeWithChildren => 'children' in node;

// DOM aliases live on their class prototypes, as they do in domhandler. Native
// views intercept the underlying fields; external supplied nodes keep theirs.
Object.defineProperties(Node.prototype, {
  cloneNode: { configurable: true, writable: true, value: cloneNode },
  parentNode: { configurable: true, get(this: Shape.Node) { return this.parent; }, set(this: Shape.Node, value: Shape.ParentNode | null) { this.parent = value; } },
  previousSibling: { configurable: true, get(this: Shape.Node) { return this.prev; }, set(this: Shape.Node, value: Shape.ChildNode | null) { this.prev = value; } },
  nextSibling: { configurable: true, get(this: Shape.Node) { return this.next; }, set(this: Shape.Node, value: Shape.ChildNode | null) { this.next = value; } },
  nodeType: { configurable: true, get(this: Shape.Node) { return ({ root: 9, text: 3, comment: 8, cdata: 4 } as Record<string, number>)[this.type] ?? 1; } },
});
Object.defineProperty(DataNode.prototype, 'nodeValue', { configurable: true, get(this: Shape.DataNode) { return this.data; }, set(this: Shape.DataNode, value: string) { this.data = value; } });
Object.defineProperties(NodeWithChildren.prototype, {
  childNodes: { configurable: true, get(this: Shape.NodeWithChildren) { return this.children; }, set(this: Shape.NodeWithChildren, value: Shape.ChildNode[]) { this.children = value; } },
  firstChild: { configurable: true, get(this: Shape.NodeWithChildren) { return this.children[0] ?? null; } },
  lastChild: { configurable: true, get(this: Shape.NodeWithChildren) { return this.children[this.children.length - 1] ?? null; } },
});
Object.defineProperties(Element.prototype, {
  tagName: { configurable: true, get(this: Shape.Element) { return this.name; }, set(this: Shape.Element, value: string) { this.name = value; } },
  attributes: { configurable: true, get(this: Shape.Element) { return Object.keys(this.attribs).map((name) => ({ name, value: this.attribs[name], namespace: this['x-attribsNamespace']?.[name], prefix: this['x-attribsPrefix']?.[name] })); } },
});
