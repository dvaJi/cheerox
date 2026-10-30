import type { NativeDocument } from './native.js';
import type { CheerioOptions } from './types.js';
import { attributeAt, isRouted, recordAt, stateIn, structureSnapshot, type DocumentState } from './router.js';
import { NodeSnapshot } from './snapshot.js';

/**
 * One compound selector: an optional type plus id, class and attribute-presence
 * tests. Lowercased names are kept for documents that lowercase names.
 */
interface Compound { tag: string | undefined; lowerTag: string | undefined; ids: string[]; classes: string[]; attributes: string[]; lowerAttributes: string[] }

const compiled = new Map<string, Compound[] | null>();
const compiledLimit = 512;

/**
 * Matches `ids` against selectors simple enough to evaluate on cached records,
 * with the native engine's semantics; `undefined` means the caller must ask
 * the native engine (any other syntax, foreign documents or parser options).
 */
export function matchSimpleSelector(document: NativeDocument, ids: readonly number[], selector: string, options: CheerioOptions): number[] | undefined {
  if (!isRouted(document)) return undefined;
  const compounds = compile(selector);
  if (!compounds) return undefined;
  const isXml = isXmlMode(options);
  const isLowerCaseTags = options.lowerCaseTags ?? !isXml;
  const isLowerCaseAttributes = options.lowerCaseAttributeNames ?? !isXml;
  const result: number[] = [];
  for (const id of ids) {
    const state = stateIn(document, id);
    if (!sameMatchOptions(state.options, isXml, isLowerCaseTags, isLowerCaseAttributes)) return undefined;
    const local = id - state.base;
    for (const compound of compounds) {
      if (matchesCompound(state, local, compound, isLowerCaseTags, isLowerCaseAttributes)) { result.push(id); break; }
    }
  }
  return result;
}

/** Nodes a single `find()` walks in JavaScript before leaving larger subtrees to the native engine. */
const walkBudget = 4096;
/** Documents small enough that walking all of them in JavaScript beats a native call. */
const smallDocumentNodes = 512;
/** Documents small enough that taking a snapshot to walk them still beats a native call. */
const tinyDocumentNodes = 64;

/**
 * Selects the descendants of one element, or of the root of a small
 * document, that match a simple selector, in document order, as the native
 * `select` does; `undefined` defers to it.
 */
export function selectSimpleWithin(document: NativeDocument, contexts: readonly number[], selector: string, options: CheerioOptions): number[] | undefined {
  if (contexts.length !== 1 || !isRouted(document)) return undefined;
  const compounds = compile(selector);
  if (!compounds) return undefined;
  const isXml = isXmlMode(options);
  const isLowerCaseTags = options.lowerCaseTags ?? !isXml;
  const isLowerCaseAttributes = options.lowerCaseAttributeNames ?? !isXml;
  const state = stateIn(document, contexts[0]);
  if (!sameMatchOptions(state.options, isXml, isLowerCaseTags, isLowerCaseAttributes)) return undefined;
  const context = contexts[0] - state.base;
  const size = Math.max(state.baseline, state.snapshotSize);
  const isDocumentRoot = context === (state.rootLocal ??= state.raw.rootId());
  const contextType = isDocumentRoot ? 'root' : typeAt(state, context);
  // After a write, walking would cost a fresh snapshot; the native engine reads the arena directly.
  // A walk reads every node: worthwhile with a current snapshot, or when a tiny unchanged document needs one.
  const isReadable = state.bulk instanceof NodeSnapshot ? size <= smallDocumentNodes : state.generation === 0 && size <= tinyDocumentNodes;
  const isSmallRoot = contextType === 'root' && isReadable;
  if (!isElementType(contextType) && !isSmallRoot) return undefined;
  const result: number[] = [];
  const stack: number[] = [];
  pushChildren(state, context, stack);
  for (let visited = 0; stack.length; visited++) {
    if (visited === walkBudget) return undefined;
    const local = stack.pop()!;
    const type = typeAt(state, local);
    // Template contents: outside an element's descendants, but selected from the document root.
    if (type === 'root') { if (isSmallRoot) return undefined; continue; }
    if (isElementType(type)) {
      for (const compound of compounds) {
        if (matchesCompound(state, local, compound, isLowerCaseTags, isLowerCaseAttributes)) { result.push(state.base + local); break; }
      }
    }
    pushChildren(state, local, stack);
  }
  return result;
}

const isElementType = (type: string | undefined): boolean => type === 'tag' || type === 'script' || type === 'style';

function typeAt(state: DocumentState, local: number): string | undefined {
  const snapshot = structureSnapshot(state, local);
  return snapshot ? snapshot.typeOf(local) : recordAt(state, local)?.type;
}

/** Pushes children last to first, so they pop in document order. */
function pushChildren(state: DocumentState, local: number, stack: number[]): void {
  const snapshot = structureSnapshot(state, local);
  if (snapshot) {
    for (let index = snapshot.childCount(local) - 1; index >= 0; index--) stack.push(snapshot.childAt(local, index));
    return;
  }
  const children = recordAt(state, local)?.children ?? [];
  for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
}

function isXmlMode(options: CheerioOptions): boolean {
  return options.xmlMode ?? (options.xml === true || typeof options.xml === 'object' && options.xml !== null);
}

/** Records were parsed with the document's options; matching must use the same name casing. */
function sameMatchOptions(documentOptions: CheerioOptions, isXml: boolean, isLowerCaseTags: boolean, isLowerCaseAttributes: boolean): boolean {
  const isDocumentXml = isXmlMode(documentOptions);
  return isDocumentXml === isXml
    && (documentOptions.lowerCaseTags ?? !isDocumentXml) === isLowerCaseTags
    && (documentOptions.lowerCaseAttributeNames ?? !isDocumentXml) === isLowerCaseAttributes;
}

function matchesCompound(state: DocumentState, local: number, compound: Compound, isLowerCaseTags: boolean, isLowerCaseAttributes: boolean): boolean {
  const snapshot = structureSnapshot(state, local);
  const record = snapshot ? undefined : recordAt(state, local);
  if (!snapshot && !record) return false;
  if (!isElementType(snapshot ? snapshot.typeOf(local) : record!.type)) return false;
  if (compound.tag !== undefined && (snapshot ? snapshot.nameOf(local) : record!.name) !== (isLowerCaseTags ? compound.lowerTag : compound.tag)) return false;
  for (const id of compound.ids) if (attributeAt(state, local, 'id') !== id) return false;
  if (compound.classes.length) {
    const classes = attributeAt(state, local, 'class');
    if (classes === undefined) return false;
    for (const name of compound.classes) if (!hasClass(classes, name)) return false;
  }
  for (const name of isLowerCaseAttributes ? compound.lowerAttributes : compound.attributes) if (attributeAt(state, local, name) === undefined) return false;
  return true;
}

const isAsciiWhitespace = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 12 || code === 13;

/** Whether `name` is one of the ASCII-whitespace-separated tokens of `classes`. */
function hasClass(classes: string, name: string): boolean {
  for (let start = classes.indexOf(name); start !== -1; start = classes.indexOf(name, start + 1)) {
    const end = start + name.length;
    if ((start === 0 || isAsciiWhitespace(classes.charCodeAt(start - 1))) && (end === classes.length || isAsciiWhitespace(classes.charCodeAt(end)))) return true;
  }
  return false;
}

function asciiLowerCase(value: string): string {
  return /[A-Z]/.test(value) ? value.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : value;
}

function compile(selector: string): Compound[] | null {
  const cached = compiled.get(selector);
  if (cached !== undefined) return cached;
  const result = parse(selector);
  if (compiled.size >= compiledLimit) compiled.clear();
  compiled.set(selector, result);
  return result;
}

const identifierStart = /[A-Za-z_]/;
const identifierPart = /[A-Za-z0-9_-]/;

/** Parses the supported subset; anything else (escapes, combinators, pseudos, values) yields `null`. */
function parse(selector: string): Compound[] | null {
  const compounds: Compound[] = [];
  let index = 0;
  const skipSpace = (): void => { while (index < selector.length && isAsciiWhitespace(selector.charCodeAt(index))) index++; };
  const identifier = (): string | null => {
    const start = index;
    if (selector[index] === '-') index++;
    if (!identifierStart.test(selector[index] ?? '')) return null;
    while (index < selector.length && identifierPart.test(selector[index])) index++;
    return selector.slice(start, index);
  };
  for (;;) {
    skipSpace();
    const compound: Compound = { tag: undefined, lowerTag: undefined, ids: [], classes: [], attributes: [], lowerAttributes: [] };
    let hasPart = false;
    if (selector[index] === '*') { index++; hasPart = true; }
    else if (/[A-Za-z]/.test(selector[index] ?? '')) { compound.tag = identifier()!; hasPart = true; }
    for (;;) {
      const character = selector[index];
      if (character === '#' || character === '.') {
        index++;
        const name = identifier();
        if (name === null) return null;
        (character === '#' ? compound.ids : compound.classes).push(name);
      } else if (character === '[') {
        index++;
        skipSpace();
        const name = identifier();
        if (name === null) return null;
        skipSpace();
        if (selector[index] !== ']') return null;
        index++;
        compound.attributes.push(name);
      } else break;
      hasPart = true;
    }
    if (!hasPart) return null;
    compound.lowerTag = compound.tag === undefined ? undefined : asciiLowerCase(compound.tag);
    compound.lowerAttributes = compound.attributes.map(asciiLowerCase);
    compounds.push(compound);
    skipSpace();
    if (index === selector.length) return compounds;
    if (selector[index] !== ',') return null;
    index++;
  }
}
