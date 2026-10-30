import type { AnyNode, Document, Element, ParentNode, CheerioAPI, CheerioOptions, AcceptedFilters, BasicAcceptedElems, AcceptedElems, ExtractMap, ExtractedMap } from './types.js';
import { requireNative, type NativeDocument } from './native.js';
import { getNode, importNodes, nodeBinding, nodeId, nodeRecord, operation, isTag, traverseRecords, viewId } from './nodes.js';
import { installAttributes, type AttributeMethods } from './attributes.js';
import { extract } from './extract.js';
import { API, DOCUMENT, exposeDocumentTo, IDS, IS_PLAIN, LEASE, leaseNodes, routeDocument, sameNodeSpace, updateLease, VALUES, type Lease } from './router.js';
import { parse } from './parse.js';
import { matchSimpleSelector, selectSimpleWithin } from './match.js';
const numeric = /^(?:0|[1-9]\d*)$/;
const isMarkup = (value: string) => /<[a-zA-Z!/?]/.test(value);
function* customPseudoArguments(selector: string, name: string): Generator<string | undefined> {
    let attributeDepth = 0;
    let quote = '';
    for (let index = 0; index < selector.length; index++) {
        const character = selector[index];
        if (character === '\\') {
            index++;
            continue;
        }
        if (quote) {
            if (character === quote)
                quote = '';
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === '[') {
            attributeDepth++;
            continue;
        }
        if (character === ']') {
            attributeDepth--;
            continue;
        }
        if (attributeDepth || character !== ':' || selector[index - 1] === ':')
            continue;
        const start = index + 1;
        let end = start;
        while (/[\w-]/.test(selector[end] ?? '') && end < selector.length)
            end++;
        if (selector.slice(start, end).toLowerCase() !== name.toLowerCase())
            continue;
        index = end - 1;
        if (selector[end] !== '(') {
            yield undefined;
            continue;
        }
        const argumentStart = end + 1;
        let depth = 1;
        let argumentQuote = '';
        for (end++; end < selector.length; end++) {
            const next = selector[end];
            if (next === '\\') {
                end++;
                continue;
            }
            if (argumentQuote) {
                if (next === argumentQuote)
                    argumentQuote = '';
                continue;
            }
            if (next === '"' || next === "'") {
                argumentQuote = next;
                continue;
            }
            if (next === '(')
                depth++;
            else if (next === ')' && --depth === 0)
                break;
        }
        if (depth)
            continue; // The native selector parser reports malformed syntax.
        yield selector.slice(argumentStart, end);
        index = end;
    }
}
const isIndex = (property: string | symbol): boolean => {
    if (typeof property !== 'string') return false;
    const first = property.charCodeAt(0);
    return first >= 48 && first <= 57 && numeric.test(property);
};
/** Results up to this size are plain objects holding their nodes, like Cheerio's own selections. */
const plainSelectionLimit = 16;
const lengthOf = (target: Cheerio<any>): number => target[VALUES]?.length ?? target[IDS].length;
function nodeAt(target: Cheerio<any>, index: number): any {
    if (target[VALUES]) return target[VALUES][index];
    const id = target[IDS][index];
    return id === undefined ? undefined : getNode(target[DOCUMENT], id);
}
function releaseIds(target: Cheerio<any>): void {
    if (target[LEASE]) updateLease(target[DOCUMENT], target[LEASE], target[VALUES] ? [] : target[IDS]);
}
function writeIndex(target: Cheerio<any>, index: number, value: any): void {
    if (target[VALUES]) target[VALUES][index] = value;
    else {
        const id = importNodes(target[DOCUMENT], [value])[0];
        if (id === undefined) {
            target[VALUES] = target[IDS].map((existing) => getNode(target[DOCUMENT], existing));
            target[VALUES][index] = value;
        }
        else target[IDS][index] = id;
    }
    releaseIds(target);
}
/** Large selections resolve nodes only when an index is read. */
const selectionHandler: ProxyHandler<Cheerio<any>> = {
    get: (target, property) => isIndex(property) ? nodeAt(target, Number(property)) : property === 'length' ? lengthOf(target) : Reflect.get(target, property),
    set: (target, property, value) => {
        if (isIndex(property)) { writeIndex(target, Number(property), value); return true; }
        if (property === 'length') {
            if (target[VALUES]) target[VALUES].length = value;
            else target[IDS].length = value;
            releaseIds(target);
            return true;
        }
        return Reflect.set(target, property, value);
    },
    has: (target, property) => isIndex(property) ? Number(property) < lengthOf(target) : property === 'length' || Reflect.has(target, property),
    ownKeys: (target) => [...Array.from({ length: lengthOf(target) }, (_, i) => String(i)), 'length', ...Reflect.ownKeys(target)],
    getOwnPropertyDescriptor: (target, property) => {
        if (isIndex(property) && Number(property) < lengthOf(target))
            return { value: nodeAt(target, Number(property)), writable: true, configurable: true, enumerable: true };
        if (property === 'length') return { value: lengthOf(target), writable: true, configurable: true, enumerable: true };
        return Reflect.getOwnPropertyDescriptor(target, property);
    },
    deleteProperty: (target, property) => {
        if (isIndex(property)) {
            if (target[VALUES])
                delete target[VALUES][Number(property)];
            else
                delete target[IDS][Number(property)];
            releaseIds(target);
            return true;
        }
        return Reflect.deleteProperty(target, property);
    },
};
/** An array-like selection of native nodes. */
export class Cheerio<T = AnyNode> implements ArrayLike<T>, Iterable<T> {
    [index: number]: T;
    /** @internal */ declare [DOCUMENT]: NativeDocument;
    /** @internal */ declare [API]: CheerioAPI;
    /** @internal */ declare [IDS]: number[];
    /** @internal */ declare [VALUES]: T[] | undefined;
    /** @internal */ declare [LEASE]: Lease | undefined;
    /** @internal Whether the selection holds its items as own index properties, as Cheerio's selections do. */ declare [IS_PLAIN]: boolean;
    /** @internal */ get _document(): NativeDocument { return this[DOCUMENT]; }
    /** @internal */ get _api(): CheerioAPI { return this[API]; }
    /** @internal */ get _ids(): number[] { return this[IDS]; }
    declare length: number;
    declare options: CheerioOptions;
    declare _root: Cheerio<Document> | null;
    declare prevObject: Cheerio<any> | undefined;
    declare cheerio: '[cheerio object]';
    constructor(api: CheerioAPI, document: NativeDocument, ids: number[] = [], root: Cheerio<Document> | null = null, options: CheerioOptions = {}, values?: T[]) {
        this[DOCUMENT] = document;
        this[API] = api;
        this[IDS] = ids;
        this[VALUES] = values;
        this[LEASE] = undefined;
        const count = values ? values.length : ids.length;
        const isPlain = count <= plainSelectionLimit;
        this[IS_PLAIN] = isPlain;
        // Own keys enumerate in Cheerio's order: length, options, _root.
        if (isPlain) this.length = count;
        this.options = options;
        this._root = root;
        if (isPlain) {
            // Each node object keeps its own node alive, so a plain selection needs no lease.
            if (values) for (let index = 0; index < count; index++) this[index] = values[index];
            else for (let index = 0; index < count; index++) this[index] = getNode(document, ids[index]) as T;
            return;
        }
        if (!values) this[LEASE] = leaseNodes(document, this, ids);
        return new Proxy(this, selectionHandler);
    }
    /** @internal Re-reads a plain selection after direct index writes or after its nodes moved documents. */
    _syncIndices(): void {
        const length = this.length;
        const values = this[VALUES];
        const ids = this[IDS];
        let isChanged = (values ?? ids).length !== length;
        for (let index = 0; !isChanged && index < length; index++) isChanged = values ? this[index] !== values[index] : viewId(this[index]) !== ids[index];
        if (!isChanged) return;
        const items: T[] = Array.from({ length }, (_unused, index) => this[index]);
        const isAllNodes = items.every((value: any) => value && typeof value === 'object' && typeof value.type === 'string');
        this[VALUES] = isAllNodes ? undefined : items;
        this[IDS] = isAllNodes ? importNodes(this[DOCUMENT], items) : [];
    }
    /** @internal */ get ids(): number[] {
        if (this[IS_PLAIN]) this._syncIndices();
        return this[VALUES] ? importNodes(this[DOCUMENT], this[VALUES]) : this[IDS];
    }
    /** @internal */ op<R = any>(command: string, args: unknown = {}): R { const values = args as Record<string, unknown>; return operation<R>(this[DOCUMENT], command, { ...values, options: values.options ?? this.options }); }
    /** @internal */ _query(command: 'select' | 'matches', args: {
        selector: string;
        ids?: number[];
        contexts?: number[];
        options?: CheerioOptions;
    }): number[] {
        const pseudos = this.options.pseudos;
        const callbacks = pseudos ? Object.entries(pseudos).filter((entry): entry is [
            string,
            (element: Element, argument?: string | null) => boolean
        ] => typeof entry[1] === 'function') : [];
        if (!callbacks.length) {
            if (command === 'matches' && args.ids) {
                const matched = matchSimpleSelector(this[DOCUMENT], args.ids, args.selector, args.options ?? this.options);
                if (matched) return matched;
            }
            if (command === 'select' && args.contexts) {
                const found = selectSimpleWithin(this[DOCUMENT], args.contexts, args.selector, args.options ?? this.options);
                if (found) return found;
            }
            return command === 'select' && !args.options ? this[DOCUMENT].select(args.selector, args.contexts) : this.op(command, args);
        }
        const pseudoMatches: Record<string, number[]> = {};
        const candidates = [...new Set([...this[DOCUMENT].select('*'), ...(args.ids ?? []), ...(args.contexts ? this[DOCUMENT].select('*', args.contexts) : [])])];
        for (const [name, callback] of callbacks) {
            for (const argument of customPseudoArguments(args.selector, name)) {
                if (argument !== undefined && callback.length < 2)
                    throw new Error(`Pseudo-class :${name} doesn't have any arguments`);
                if (argument === undefined && callback.length >= 2)
                    throw new Error(`Pseudo-class :${name} requires an argument`);
                pseudoMatches[`${name}(${argument ?? ''})`] = candidates.filter((id) => callback(getNode(this[DOCUMENT], id) as Element, argument ?? null));
            }
        }
        return this.op(command, { ...args, pseudoMatches });
    }
    /** @internal */ _fromIds<R = AnyNode>(ids: number[]): Cheerio<R> {
        const result = new (this[API].fn.constructor as typeof Cheerio)<R>(this[API], this[DOCUMENT], ids, this._root, this.options);
        result.prevObject = this;
        return result;
    }
    /** @internal */ _fromValues<R>(values: R[]): Cheerio<R> {
        const allNodes = values.every((value: any) => value && typeof value === 'object' && typeof value.type === 'string');
        const result = new (this[API].fn.constructor as typeof Cheerio)<R>(this[API], this[DOCUMENT], allNodes ? importNodes(this[DOCUMENT], values) : [], this._root, this.options, allNodes ? undefined : values);
        result.prevObject = this;
        return result;
    }
    _make<R>(value: ArrayLike<R> | R | string, context?: BasicAcceptedElems<AnyNode>): Cheerio<R>;
    _make<R>(value: any, context?: any): Cheerio<R> {
        const result = typeof value === 'string' || value?.cheerio ? this[API](value, context) : this._fromValues<R>(value == null ? [] : typeof value === 'object' && 'length' in value && !value.type ? Array.from(value) : [value]);
        result.prevObject = this;
        return result as Cheerio<R>;
    }
    _parse(content: any, options: CheerioOptions, isDocument: boolean, context: ParentNode | null): Document {
        return parse(content, options, isDocument, context);
    }
    _render(content: any): string { return this[DOCUMENT].outerHtml(importNodes(this[DOCUMENT], content)); }
    /** @internal */ _domIds(content: any, contextId?: number): number[] {
        if (content == null || content === false)
            return [];
        if (typeof content === 'string')
            return this.op('create', { html: content, contextId, options: this.options });
        if (content?.cheerio) {
            if (!content[DOCUMENT] || !sameNodeSpace(this[DOCUMENT], content[DOCUMENT]))
                return importNodes(this[DOCUMENT], content.toArray());
            exposeDocumentTo(this[DOCUMENT], content[DOCUMENT]);
            return content.ids;
        }
        if (typeof content === 'object' && 'length' in content && !content.type)
            return Array.from(content as ArrayLike<any>).flatMap((item) => this._domIds(item, contextId));
        return importNodes(this[DOCUMENT], [content]);
    }
    _makeDomArray<T extends AnyNode>(this: Cheerio<T>, elem?: BasicAcceptedElems<AnyNode> | BasicAcceptedElems<AnyNode>[], clone?: boolean): AnyNode[];
    _makeDomArray(this: Cheerio<any>, content: any, clone: any = false): any {
        const ids = this._domIds(content);
        return (clone ? this.op<number[]>('clone', { ids, deep: true }) : ids).map((id) => getNode(this[DOCUMENT], id));
    }
    find<T extends AnyNode>(this: Cheerio<T>, selectorOrHaystack?: string | Cheerio<Element> | Element): Cheerio<Element>;
    find(this: Cheerio<any>, selector?: any): any {
        if (!selector)
            return this._fromIds([]);
        if (typeof selector === 'string')
            return this._findBySelector(selector, Infinity);
        const ids = importNodes(this[DOCUMENT], selector);
        return this._fromIds(ids.filter((id) => this.ids.some((container) => this.op<boolean>('contains', { container, contained: id }))));
    }
    _findBySelector<T extends AnyNode>(this: Cheerio<T>, selector: string, limit: number): Cheerio<Element>;
    _findBySelector(this: Cheerio<any>, selector: any, limit: any): any {
        const ids = this._query('select', { selector, contexts: this.ids });
        return this._fromIds(Number.isFinite(limit) ? ids.slice(0, limit) : ids);
    }
    /** @internal */ _filterIds(ids: number[], selector?: any): number[] {
        if (!selector)
            return ids;
        if (typeof selector === 'string')
            return this._query('matches', { ids, selector, options: this.options });
        return ids.filter((id, index) => this._predicate(selector, getNode(this[DOCUMENT], id), index));
    }
    /** @internal */ _predicate(selector: any, node: any, index: number): boolean {
        if (typeof selector === 'function')
            return !!selector.call(node, index, node);
        if (typeof selector === 'string')
            return this._query('matches', { ids: importNodes(this[DOCUMENT], [node]), selector, options: this.options }).length > 0;
        if (selector?.cheerio)
            return selector.toArray().includes(node);
        return node === selector;
    }
    /** @internal */ _traverse(kind: string, selector?: any): Cheerio<Element> {
        let ids = traverseRecords(this[DOCUMENT], this.ids, kind) ?? this.op<number[]>('traverse', { ids: this.ids, kind });
        ids = this._filterIds(ids, selector);
        if (this.length > 1 && ids.length > 1) {
            if (kind === 'parents' || kind === 'siblings')
                ids = this.op('uniqueSort', { ids });
            else if (!['next', 'prev', 'contents'].includes(kind))
                ids = [...new Set(ids)];
            if (kind === 'parents')
                ids.reverse();
        }
        return this._fromIds(ids);
    }
    parent<T extends AnyNode>(this: Cheerio<T>, selector?: AcceptedFilters<Element>): Cheerio<Element>;
    parent(this: Cheerio<any>, selector?: any): any { return this._traverse('parent', selector); }
    parents<T extends AnyNode>(this: Cheerio<T>, selector?: AcceptedFilters<Element>): Cheerio<Element>;
    parents(this: Cheerio<any>, selector?: any): any { return this._traverse('parents', selector); }
    next<T extends AnyNode>(this: Cheerio<T>, selector?: AcceptedFilters<Element>): Cheerio<Element>;
    next(this: Cheerio<any>, selector?: any): any { return this._traverse('next', selector); }
    prev<T extends AnyNode>(this: Cheerio<T>, selector?: AcceptedFilters<Element>): Cheerio<Element>;
    prev(this: Cheerio<any>, selector?: any): any { return this._traverse('prev', selector); }
    nextAll<T extends AnyNode>(this: Cheerio<T>, selector?: AcceptedFilters<Element>): Cheerio<Element>;
    nextAll(this: Cheerio<any>, selector?: any): any { return this._traverse('nextAll', selector); }
    prevAll<T extends AnyNode>(this: Cheerio<T>, selector?: AcceptedFilters<Element>): Cheerio<Element>;
    prevAll(this: Cheerio<any>, selector?: any): any { return this._traverse('prevAll', selector); }
    siblings<T extends AnyNode>(this: Cheerio<T>, selector?: AcceptedFilters<Element>): Cheerio<Element>;
    siblings(this: Cheerio<any>, selector?: any): any { return this._traverse('siblings', selector); }
    children<T extends AnyNode>(this: Cheerio<T>, selector?: AcceptedFilters<Element>): Cheerio<Element>;
    children(this: Cheerio<any>, selector?: any): any { return this._traverse('children', selector); }
    contents<T extends AnyNode>(this: Cheerio<T>): Cheerio<AnyNode>;
    contents(this: Cheerio<any>): any { return this._traverse('contents') as any; }
    /** @internal */ _until(kind: string, until?: any, filter?: any): Cheerio<Element> {
        let ids: number[] = [];
        for (const id of this.ids)
            for (const candidate of traverseRecords(this[DOCUMENT], [id], kind) ?? this.op<number[]>('traverse', { ids: [id], kind })) {
                if (until && this._predicate(until, getNode(this[DOCUMENT], candidate), ids.length))
                    break;
                ids.push(candidate);
            }
        ids = this._filterIds(ids, filter);
        if (this.length > 1 && ids.length > 1)
            ids = kind === 'parents' ? this.op<number[]>('uniqueSort', { ids }).reverse() : [...new Set(ids)];
        return this._fromIds(ids);
    }
    parentsUntil<T extends AnyNode>(this: Cheerio<T>, selector?: AcceptedFilters<Element> | null, filterSelector?: AcceptedFilters<Element>): Cheerio<Element>;
    parentsUntil(this: Cheerio<any>, until?: any, filter?: any): any { return this._until('parents', until, filter); }
    nextUntil<T extends AnyNode>(this: Cheerio<T>, selector?: AcceptedFilters<Element> | null, filterSelector?: AcceptedFilters<Element>): Cheerio<Element>;
    nextUntil(this: Cheerio<any>, until?: any, filter?: any): any { return this._until('nextAll', until, filter); }
    prevUntil<T extends AnyNode>(this: Cheerio<T>, selector?: AcceptedFilters<Element> | null, filterSelector?: AcceptedFilters<Element>): Cheerio<Element>;
    prevUntil(this: Cheerio<any>, until?: any, filter?: any): any { return this._until('prevAll', until, filter); }
    closest<T extends AnyNode>(this: Cheerio<T>, selector?: AcceptedFilters<Element>): Cheerio<AnyNode>;
    closest(this: Cheerio<any>, selector?: any): any {
        if (!selector)
            return this._fromIds([]);
        const result: number[] = [];
        for (const id of this.ids) {
            const record = nodeRecord(this[DOCUMENT], id);
            const candidates = [...(['tag', 'script', 'style'].includes(record.type) ? [id] : []), ...(traverseRecords(this[DOCUMENT], [id], 'parents') ?? this.op<number[]>('traverse', { ids: [id], kind: 'parents' }))];
            // One native match for all candidates replaces a round trip per ancestor.
            const matched = typeof selector === 'string' ? new Set(this._filterIds(candidates, selector)) : undefined;
            const match = matched ? candidates.find((candidate) => matched.has(candidate)) : candidates.find((candidate) => this._predicate(selector, getNode(this[DOCUMENT], candidate), 0));
            if (match !== undefined && !result.includes(match))
                result.push(match);
        }
        return this._fromIds(result);
    }
    each<T>(this: Cheerio<T>, fn: (this: T, i: number, el: T) => void | boolean): Cheerio<T>;
    each(this: Cheerio<any>, callback: any): any {
        if (this[IS_PLAIN]) {
            const length = this.length;
            for (let i = 0; i < length; i++)
                if (callback.call(this[i], i, this[i]) === false)
                    break;
            return this;
        }
        // Reading ids directly avoids a string-keyed proxy trap per index.
        const values = this[VALUES], ids = this[IDS], document = this[DOCUMENT];
        const length = values ? values.length : ids.length;
        for (let i = 0; i < length; i++) {
            const node = values ? values[i] : getNode(document, ids[i]);
            if (callback.call(node, i, node) === false)
                break;
        }
        return this;
    }
    map<T, M>(this: Cheerio<T>, fn: (this: T, i: number, el: T) => M[] | M | null | undefined): Cheerio<M>;
    map<R>(this: Cheerio<any>, callback: any): any {
        const result: R[] = [];
        const items = this._items();
        for (let i = 0; i < items.length; i++) {
            const value = callback.call(items[i], i, items[i]);
            if (value != null)
                result.push(...(Array.isArray(value) ? value : [value]));
        }
        return this._fromValues(result);
    }
    filter<T, S extends T>(this: Cheerio<T>, match: (this: T, index: number, value: T) => value is S): Cheerio<S>;
    filter<T, S extends AcceptedFilters<T>>(this: Cheerio<T>, match: S): Cheerio<S extends string ? Element : T>;
    filter<S extends AcceptedFilters<T>>(this: Cheerio<any>, selector: any): any {
        return (typeof selector === 'string' ? this._fromIds(this._query('matches', { ids: this.ids, selector, options: this.options })) : this._fromValues(this.toArray().filter((node, i) => this._predicate(selector, node, i)))) as any;
    }
    filterArray<T>(nodes: T[], match: AcceptedFilters<T>, xmlMode?: boolean, root?: Document): Element[] | T[];
    filterArray<R>(this: Cheerio<any>, nodes: any, match: any, xmlMode?: any, root?: any): any {
        const matcher: any = match;
        if (typeof match !== 'string')
            return nodes.filter((node: any, index: number) => typeof matcher === 'function' ? matcher.call(node, index, node) : matcher?.cheerio ? matcher.toArray().includes(node) : matcher === node);
        const document = this?.[DOCUMENT] ?? nodeBinding(root)?.document ?? nodeBinding(nodes[0])?.document ?? routeDocument(new (requireNative().NativeDocument)('', false));
        const ids = importNodes(document, nodes);
        const selected = new Set(operation<number[]>(document, 'matches', { ids, selector: match, options: { xmlMode } }));
        return nodes.filter((node: any) => { const id = nodeId(node, document); return id !== undefined && selected.has(id); });
    }
    not<T extends AnyNode>(this: Cheerio<T>, match: AcceptedFilters<T>): Cheerio<T>;
    not(this: Cheerio<any>, selector: any): any {
        if (typeof selector === 'string') {
            const matched = new Set(this._query('matches', { ids: this.ids, selector, options: this.options }));
            return this._fromIds(this.ids.filter((id) => !matched.has(id)));
        }
        return this._fromValues(this.toArray().filter((node, i) => !this._predicate(selector, node, i)));
    }
    is<T>(this: Cheerio<T>, selector?: AcceptedFilters<T>): boolean;
    is(this: Cheerio<any>, selector?: any): any {
        return typeof selector === 'string' ? this._query('matches', { ids: this.ids, selector, options: this.options }).length > 0 : !!selector && this.toArray().some((node, i) => this._predicate(selector, node, i));
    }
    has(this: Cheerio<AnyNode | Element>, selectorOrHaystack: string | Cheerio<Element> | Element): Cheerio<AnyNode | Element>;
    has(this: Cheerio<any>, selector: any): any { return this.filter(((_i: number, node: any) => this._make(node).find(selector).length > 0) as any) as Cheerio<T>; }
    first<T extends AnyNode>(this: Cheerio<T>): Cheerio<T>;
    first(this: Cheerio<any>): any { return this.length > 1 ? this.slice(0, 1) : this; }
    last<T>(this: Cheerio<T>): Cheerio<T>;
    last(this: Cheerio<any>): any { return this.length > 0 ? this.slice(-1) : this; }
    eq<T>(this: Cheerio<T>, i: number): Cheerio<T>;
    eq(this: Cheerio<any>, index: any): any {
        index = +index;
        if (index === 0 && this.length <= 1)
            return this;
        if (index < 0)
            index += this.length;
        const item = this._itemAt(index);
        return this._fromValues(item === undefined ? [] : [item]);
    }
    get<T>(this: Cheerio<T>, i: number): T | undefined;
    get<T>(this: Cheerio<T>): T[];
    get(this: Cheerio<any>, index?: any): any { return index == null ? this.toArray() : this._itemAt(index < 0 ? this.length + index : index); }
    toArray<T>(this: Cheerio<T>): T[];
    toArray(this: Cheerio<any>): any { return this._items(); }
    /** @internal Every item, read without a proxy trap per index. */
    _items(): T[] {
        if (this[IS_PLAIN]) {
            const length = this.length;
            const items: T[] = new Array(length);
            for (let i = 0; i < length; i++) items[i] = this[i];
            return items;
        }
        const values = this[VALUES], ids = this[IDS], document = this[DOCUMENT];
        return values ? values.slice() : ids.map((id) => getNode(document, id) as T);
    }
    /** @internal */ _itemAt(index: number): T | undefined {
        if (this[IS_PLAIN]) return this[index];
        const values = this[VALUES];
        if (values) return values[index];
        const id = this[IDS][index];
        return id === undefined ? undefined : getNode(this[DOCUMENT], id) as T;
    }
    slice<T>(this: Cheerio<T>, start?: number, end?: number): Cheerio<T>;
    slice(this: Cheerio<any>, start?: any, end?: any): any { const ids = this.ids; return this[VALUES] ? this._fromValues(this[VALUES].slice(start, end)) : this._fromIds(ids.slice(start, end)); }
    end<T>(this: Cheerio<T>): Cheerio<AnyNode>;
    end(this: Cheerio<any>): any { return this.prevObject ?? this._make([]); }
    add<S extends AnyNode, T extends AnyNode>(this: Cheerio<T>, other: string | Cheerio<S> | S | S[], context?: Cheerio<S> | string): Cheerio<S | T>;
    add<R extends AnyNode>(this: Cheerio<any>, other: any, context?: any): any {
        const added = this[API](other, context);
        // Ids of another copy of the package belong to its own id space.
        const addedIds = added[DOCUMENT] && sameNodeSpace(this[DOCUMENT], added[DOCUMENT]) ? added.ids : importNodes(this[DOCUMENT], added.toArray());
        return this._fromIds(this.op('uniqueSort', { ids: [...this.ids, ...addedIds] }));
    }
    addBack<T extends AnyNode>(this: Cheerio<T>, selector?: string): Cheerio<AnyNode>;
    addBack(this: Cheerio<any>, selector?: any): any { return this.prevObject ? this.add(selector ? this.prevObject.filter(selector) : this.prevObject) as any : this as any; }
    index<T extends AnyNode>(this: Cheerio<T>, selectorOrNeedle?: string | Cheerio<AnyNode> | AnyNode): number;
    index(this: Cheerio<any>, selector?: any): any { const haystack = selector == null ? this.parent().children() : typeof selector === 'string' ? this[API](selector) : this; const needle = selector == null || typeof selector === 'string' ? this[0] : selector?.cheerio ? selector[0] : selector; return haystack.toArray().indexOf(needle); }
    splice(start: number, deleteCount?: number): any[];
    splice(start: number, deleteCount: number, ...items: any[]): any[];
    splice(...args: any[]): any[] { return Reflect.apply(Array.prototype.splice, this, args); }
    [Symbol.iterator](): Iterator<T>;
    [Symbol.iterator](): IterableIterator<T> { return this._items()[Symbol.iterator](); }
    /** @internal */ _insert(position: string, content: any[]): this {
        if (typeof content[0] !== 'function') {
            // The native insert skips targets that cannot hold children, and
            // only the last listed target receives the nodes themselves.
            const ids = this.ids;
            if (ids.length) this.op('insert', { targetIds: ids, nodeIds: this._domIds(content), position });
            return this;
        }
        const targets = this.ids.filter((id) => ['root', 'tag', 'script', 'style', 'cdata'].includes(nodeRecord(this[DOCUMENT], id).type));
        if (!targets.length)
            return this;
        return (this as Cheerio<any>).each((index, node: any) => {
            if (!targets.includes(this.ids[index]))
                return;
            if ((position === 'before' || position === 'after') && nodeRecord(this[DOCUMENT], this.ids[index]).parent == null)
                return;
            const value = content[0].call(node, index, this[DOCUMENT].innerHtml(this.ids[index]));
            let nodes = this._domIds(value);
            if (index < this.length - 1)
                nodes = this.op('clone', { ids: nodes, deep: true });
            this.op('insert', { targetIds: [this.ids[index]], nodeIds: nodes, position });
        }) as this;
    }
    append<T extends AnyNode>(this: Cheerio<T>, ...elems: [
        (this: AnyNode, i: number, html: string) => BasicAcceptedElems<AnyNode>
    ] | BasicAcceptedElems<AnyNode>[]): Cheerio<T>;
    append(this: Cheerio<any>, ...content: any[]): any { return this._insert('append', content); }
    prepend<T extends AnyNode>(this: Cheerio<T>, ...elems: [
        (this: AnyNode, i: number, html: string) => BasicAcceptedElems<AnyNode>
    ] | BasicAcceptedElems<AnyNode>[]): Cheerio<T>;
    prepend(this: Cheerio<any>, ...content: any[]): any { return this._insert('prepend', content); }
    before<T extends AnyNode>(this: Cheerio<T>, ...elems: [
        (this: AnyNode, i: number, html: string) => BasicAcceptedElems<AnyNode>
    ] | BasicAcceptedElems<AnyNode>[]): Cheerio<T>;
    before(this: Cheerio<any>, ...content: any[]): any { return this._insert('before', content); }
    after<T extends AnyNode>(this: Cheerio<T>, ...elems: [
        (this: AnyNode, i: number, html: string) => BasicAcceptedElems<AnyNode>
    ] | BasicAcceptedElems<AnyNode>[]): Cheerio<T>;
    after(this: Cheerio<any>, ...content: any[]): any { return this._insert('after', content); }
    appendTo<T extends AnyNode>(this: Cheerio<T>, target: BasicAcceptedElems<AnyNode>): Cheerio<T>;
    appendTo(this: Cheerio<any>, target: any): any { this[API](target).append(this); return this; }
    prependTo<T extends AnyNode>(this: Cheerio<T>, target: BasicAcceptedElems<AnyNode>): Cheerio<T>;
    prependTo(this: Cheerio<any>, target: any): any { this[API](target).prepend(this); return this; }
    /** @internal */ _insertRelative(target: any, position: string): Cheerio<T> {
        const targets = this[API](target).ids;
        (this as Cheerio<any>).remove();
        const inserted: number[] = [];
        for (const id of targets) {
            if (nodeRecord(this[DOCUMENT], id).parent == null)
                continue;
            const clones = this.op<number[]>('clone', { ids: this.ids, deep: true });
            this.op('insert', { targetIds: [id], nodeIds: clones, position });
            inserted.push(...clones);
        }
        return this._fromIds(inserted);
    }
    insertBefore<T extends AnyNode>(this: Cheerio<T>, target: BasicAcceptedElems<AnyNode>): Cheerio<T>;
    insertBefore(this: Cheerio<any>, target: any): any { return this._insertRelative(target, 'before'); }
    insertAfter<T extends AnyNode>(this: Cheerio<T>, target: BasicAcceptedElems<AnyNode>): Cheerio<T>;
    insertAfter(this: Cheerio<any>, target: any): any { return this._insertRelative(target, 'after'); }
    remove<T extends AnyNode>(this: Cheerio<T>, selector?: string): Cheerio<T>;
    remove(this: Cheerio<any>, selector?: any): any { this.op('remove', { ids: selector ? this.filter(selector).ids : this.ids }); return this; }
    replaceWith<T extends AnyNode>(this: Cheerio<T>, content: AcceptedElems<AnyNode>): Cheerio<T>;
    replaceWith(this: Cheerio<any>, content: any): any {
        return this.each((index, node: any) => {
            if (nodeRecord(this[DOCUMENT], this.ids[index]).parent == null)
                return;
            const value = typeof content === 'function' ? content.call(node, index, node) : content;
            this.op('insert', { targetIds: [this.ids[index]], nodeIds: this._domIds(value), position: 'replace' });
        });
    }
    empty<T extends AnyNode>(this: Cheerio<T>): Cheerio<T>;
    empty(this: Cheerio<any>): any {
        for (const id of this.ids)
            this.op('setNode', { id, field: 'children', value: [] });
        return this;
    }
    html<T extends AnyNode>(this: Cheerio<T>): string | null;
    html<T extends AnyNode>(this: Cheerio<T>, str: string | Cheerio<T>): Cheerio<T>;
    html(this: Cheerio<any>, content?: any): any {
        if (content === undefined)
            return this.length && ['root', 'tag', 'script', 'style', 'cdata'].includes(nodeRecord(this[DOCUMENT], this.ids[0]).type) ? this[DOCUMENT].innerHtml(this.ids[0]) : null;
        if (!content?.cheerio) {
            this.op('html', { ids: this.ids, value: String(content) });
            return this;
        }
        for (const id of this.ids) {
            const nodes = content?.cheerio ? importNodes(this[DOCUMENT], content.toArray()) : this._domIds(String(content), id);
            this.op('setNode', { id, field: 'children', value: nodes });
        }
        return this;
    }
    text<T extends AnyNode>(this: Cheerio<T>): string;
    text<T extends AnyNode>(this: Cheerio<T>, str: string | ((this: AnyNode, i: number, text: string) => string)): Cheerio<T>;
    text(this: Cheerio<any>, content?: any): any {
        if (content === undefined)
            return this[DOCUMENT].text(this.ids);
        if (typeof content !== 'function') {
            this.op('text', { ids: this.ids, value: String(content) });
            return this;
        }
        for (let i = 0; i < this.ids.length; i++) {
            const id = this.ids[i];
            const value = typeof content === 'function' ? content.call(getNode(this[DOCUMENT], id), i, this[DOCUMENT].text([id])) : content;
            this.op('text', { ids: [id], value: String(value) });
        }
        return this;
    }
    toString<T extends AnyNode>(this: Cheerio<T>): string;
    toString(this: Cheerio<any>): any { return this[DOCUMENT].outerHtml(this.ids); }
    clone<T extends AnyNode>(this: Cheerio<T>): Cheerio<T>;
    clone(this: Cheerio<any>): any { return this._fromIds(this.op('clone', { ids: this.ids, deep: true })); }
    /** @internal */ _deepest(id: number, tagsOnly = false): number {
        for (;;) {
            const children = this.op<number[]>('traverse', { ids: [id], kind: 'children' });
            const child = tagsOnly ? children.find((candidate) => nodeRecord(this[DOCUMENT], candidate).type === 'tag') : children[0];
            if (child === undefined)
                return id;
            id = child;
        }
    }
    /** @internal */ _wrap(content: any, inner: boolean): this {
        const lastParent = (this as Cheerio<any>).parents().last();
        for (let i = 0; i < this.length; i++) {
            const id = this.ids[i];
            const node = getNode(this[DOCUMENT], id);
            const value = typeof content === 'function' ? content.call(node, i, node) : typeof content === 'string' && !isMarkup(content) ? lastParent.find(content).clone() : content;
            let wrappers = this._domIds(value);
            if (i < this.length - 1)
                wrappers = this.op('clone', { ids: wrappers, deep: true });
            const wrapper = wrappers[0];
            if (wrapper === undefined || !['root', 'tag', 'script', 'style'].includes(nodeRecord(this[DOCUMENT], wrapper).type))
                continue;
            if (inner) {
                if (!['root', 'tag', 'script', 'style', 'cdata'].includes(nodeRecord(this[DOCUMENT], id).type))
                    continue;
                const contents = this.op<number[]>('traverse', { ids: [id], kind: 'contents' });
                this.op('setNode', { id: this._deepest(wrapper), field: 'children', value: contents });
                this.op('setNode', { id, field: 'children', value: [wrapper] });
            }
            else if (nodeRecord(this[DOCUMENT], id).parent != null) {
                // A wrapper from another document gets new ids when the insertion moves it here.
                const [inserted = wrapper] = this.op<number[]>('insert', { targetIds: [id], nodeIds: [wrapper], position: 'before' });
                this.op('setNode', { id: this._deepest(inserted), field: 'children', value: [id] });
            }
        }
        return this;
    }
    wrap<T extends AnyNode>(this: Cheerio<T>, wrapper: AcceptedElems<AnyNode>): Cheerio<T>;
    wrap(this: Cheerio<any>, content: any): any { return this._wrap(content, false); }
    wrapInner<T extends AnyNode>(this: Cheerio<T>, wrapper: AcceptedElems<AnyNode>): Cheerio<T>;
    wrapInner(this: Cheerio<any>, content: any): any { return this._wrap(content, true); }
    unwrap<T extends AnyNode>(this: Cheerio<T>, selector?: string): Cheerio<T>;
    unwrap(this: Cheerio<any>, selector?: any): any { this.op('remove', { ids: this.parent(selector).not('body').ids, keepChildren: true }); return this; }
    wrapAll<T extends AnyNode>(this: Cheerio<T>, wrapper: AcceptedElems<T>): Cheerio<T>;
    wrapAll(this: Cheerio<any>, content: any): any {
        if (!this.length)
            return this;
        const first = this[0];
        const wrappers = this._make(typeof content === 'function' ? content.call(first, 0, first) : content).insertBefore(first);
        const root = [...wrappers.ids].reverse().find((id) => nodeRecord(this[DOCUMENT], id).type === 'tag');
        if (root !== undefined)
            this.op('insert', { targetIds: [this._deepest(root, true)], nodeIds: this.ids, position: 'append' });
        return this;
    }
    extract<M extends ExtractMap, T extends AnyNode>(this: Cheerio<T>, map: M): ExtractedMap<M>;
    // A structurally shared object signature breaks recursive enum comparisons
    // across independent DOM declarations; calls retain the precise overload.
    extract<M extends ExtractMap, T extends AnyNode>(this: Cheerio<T>, map: M): Record<string, unknown>;
    extract<M extends ExtractMap>(this: Cheerio<any>, map: any): any { return extract.call(this as any, map) as ExtractedMap<M>; }
}
Object.defineProperty(Cheerio.prototype, 'cheerio', { value: '[cheerio object]', writable: true, configurable: true });
const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
// Inspection shows the selection's own string keys, as Cheerio's selections
// have, without the internals stored under symbols.
Object.defineProperty(Cheerio.prototype, inspectCustom, {
    configurable: true, writable: true,
    value(this: Cheerio<any>, depth: number, options: { stylize(text: string, style: string): string }, inspect: (value: unknown, options: object) => string): string {
        const prototype = Object.getPrototypeOf(this);
        if (depth < 0) return options.stylize(`[${prototype.constructor.name}]`, 'special');
        const shown: Record<string | symbol, unknown> = Object.create(prototype);
        Object.defineProperty(shown, inspectCustom, { value: undefined });
        for (const key of Object.keys(this)) shown[key] = (this as any)[key];
        return inspect(shown, { ...options, depth });
    },
});
export interface Cheerio<T = AnyNode> extends AttributeMethods<T> {
}
installAttributes(Cheerio);

/** @internal */
export const nativeExtractionMethods = Object.freeze({
    make: Cheerio.prototype._make,
    find: Cheerio.prototype._findBySelector,
    prop: Cheerio.prototype.prop,
    extract: Cheerio.prototype.extract,
});
