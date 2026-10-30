import type { Cheerio } from './selection.js';
import type { ParserErrorHandler, TreeAdapter, TokenizerConstructor } from './parser-types.js';
export type * from './parser-types.js';

/** DOM-compatible views over stable nodes owned by the native document. */
export declare enum ElementType {
  Root = 'root', Text = 'text', Directive = 'directive', Comment = 'comment',
  Script = 'script', Style = 'style', Tag = 'tag', CDATA = 'cdata', Doctype = 'doctype',
}

export interface SourceCodeLocation {
  startLine: number; startCol: number; startOffset: number;
  endLine: number; endCol: number; endOffset: number;
}
export interface TagSourceCodeLocation extends SourceCodeLocation { startTag?: SourceCodeLocation; endTag?: SourceCodeLocation; attrs?: Record<string, SourceCodeLocation> }

export interface Node {
  readonly type: ElementType;
  parent: ParentNode | null;
  prev: ChildNode | null;
  next: ChildNode | null;
  startIndex: number | null;
  endIndex: number | null;
  readonly nodeType: number;
  parentNode: ParentNode | null;
  previousSibling: ChildNode | null;
  nextSibling: ChildNode | null;
  sourceCodeLocation?: SourceCodeLocation | null;
  cloneNode<T extends Node>(this: T, recursive?: boolean): T;
}

export interface DataNode extends Node { data: string; nodeValue: string }
export interface Text extends DataNode { type: ElementType.Text; readonly nodeType: 3 }
export interface Comment extends DataNode { type: ElementType.Comment; readonly nodeType: 8 }
export interface ProcessingInstruction extends DataNode {
  type: ElementType.Directive;
  name: string;
  readonly nodeType: 1;
  'x-name'?: string;
  'x-publicId'?: string;
  'x-systemId'?: string;
}
export interface NodeWithChildren extends Node {
  children: ChildNode[];
  childNodes: ChildNode[];
  readonly firstChild: ChildNode | null;
  readonly lastChild: ChildNode | null;
}
export interface Document extends NodeWithChildren { type: ElementType.Root; readonly nodeType: 9; 'x-mode'?: 'quirks' | 'limited-quirks' | 'no-quirks' }
export interface CDATA extends NodeWithChildren { type: ElementType.CDATA; readonly nodeType: 4 }
export interface Element extends NodeWithChildren {
  type: ElementType.Tag | ElementType.Script | ElementType.Style;
  readonly nodeType: 1;
  name: string;
  tagName: string;
  attribs: Record<string, string>;
  namespace?: string;
  sourceCodeLocation?: TagSourceCodeLocation | null;
  readonly attributes: { name: string; value: string; namespace?: string; prefix?: string }[];
  'x-attribsNamespace'?: Record<string, string>;
  'x-attribsPrefix'?: Record<string, string>;
}
export type ParentNode = Document | Element | CDATA;
export type ChildNode = Text | Comment | ProcessingInstruction | Element | CDATA | Document;
export type AnyNode = ParentNode | ChildNode;

export interface HTMLParser2Options {
  xmlMode?: boolean;
  decodeEntities?: boolean;
  encodeEntities?: boolean | 'utf8';
  lowerCaseTags?: boolean;
  lowerCaseAttributeNames?: boolean;
  recognizeCDATA?: boolean;
  recognizeSelfClosing?: boolean;
  withStartIndices?: boolean;
  withEndIndices?: boolean;
  emptyAttrs?: boolean;
  selfClosingTags?: boolean;
  Tokenizer?: TokenizerConstructor;
  [key: string]: any;
}

export interface CheerioOptions extends HTMLParser2Options {
  xml?: boolean | HTMLParser2Options;
  baseURI?: string | URL;
  quirksMode?: boolean;
  scriptingEnabled?: boolean;
  sourceCodeLocationInfo?: boolean;
  treeAdapter?: TreeAdapter;
  onParseError?: ParserErrorHandler | null;
  pseudos?: Record<string, string | ((element: Element, value?: string | null) => boolean)>;
  _useHtmlParser2?: boolean;
}
export type InternalOptions = CheerioOptions;

type LowercaseLetters = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm' | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z';
type AlphaNumeric = LowercaseLetters | Uppercase<LowercaseLetters> | `${number}`;
export type SelectorType = `${'.' | '#' | ':' | '|' | '>' | '+' | '~' | '['}${AlphaNumeric}${string}` | `${AlphaNumeric}${string}`;
export type BasicAcceptedElems<T extends AnyNode = AnyNode> = ArrayLike<T> | T | string;
export type AcceptedElems<T extends AnyNode = AnyNode> = BasicAcceptedElems<T> | ((this: T, index: number, element: T) => BasicAcceptedElems<T>);
export type FilterFunction<T> = (this: T, index: number, element: T) => boolean;
export type AcceptedFilters<T> = string | FilterFunction<T> | T | Cheerio<T>;
export type LoadContent = string | Buffer | AnyNode | ArrayLike<AnyNode>;

export interface CheerioAPI {
  <T extends AnyNode, S extends string>(
    selector?: S | BasicAcceptedElems<T>,
    context?: BasicAcceptedElems<AnyNode> | null,
    root?: BasicAcceptedElems<Document>,
    options?: CheerioOptions,
  ): Cheerio<S extends SelectorType ? Element : T>;
  <T extends AnyNode, S extends string>(
    selector?: S | BasicAcceptedElems<T>,
    context?: BasicAcceptedElems<AnyNode> | null,
    root?: BasicAcceptedElems<Document>,
    options?: CheerioOptions,
  ): Cheerio<AnyNode>;
  html(options?: CheerioOptions): string;
  html(dom?: BasicAcceptedElems<AnyNode> | Cheerio<AnyNode>, options?: CheerioOptions): string;
  xml(dom?: BasicAcceptedElems<AnyNode> | Cheerio<AnyNode>): string;
  text(elements?: ArrayLike<AnyNode>): string;
  root(): Cheerio<Document>;
  contains(container: AnyNode, contained: AnyNode): boolean;
  merge<T>(first: ArrayLike<T>, second: ArrayLike<T>): ArrayLike<T> | undefined;
  parseHTML(data: string, context?: unknown, keepScripts?: boolean): AnyNode[];
  parseHTML(data?: '' | null): null;
  load(content: LoadContent, options?: CheerioOptions | null, isDocument?: boolean): CheerioAPI;
  extract<M extends ExtractMap>(this: CheerioAPI, map: M): ExtractedMap<M>;
  extract<M extends ExtractMap>(this: CheerioAPI, map: M): Record<string, unknown>;
  fn: typeof Cheerio.prototype;
  _root: Document;
  _options: InternalOptions;
  [key: string]: any;
}

type ExtractDescriptorFn = (element: Element, key: string, result: Record<string, unknown>) => unknown;
export interface ExtractDescriptor {
  selector: string;
  value?: string | ExtractDescriptorFn | ExtractMap;
}
type ExtractValue = string | ExtractDescriptor | [string | ExtractDescriptor];
export type ExtractMap = Record<string, ExtractValue>;
export type ExtractedValue<V extends ExtractValue> = V extends [string | ExtractDescriptor]
  ? NonNullable<ExtractedValue<V[0]>>[]
  : V extends string ? string | undefined
  : V extends ExtractDescriptor ? V['value'] extends infer U
    ? U extends ExtractMap ? ExtractedMap<U> | undefined
    : U extends ExtractDescriptorFn ? ReturnType<U> | undefined
    : string | undefined
    : never
  : never;
export type ExtractedMap<M extends ExtractMap> = {
  [key in keyof M]: ExtractedValue<M[key]>;
};
export type ExtractionDescriptor = ExtractDescriptor;
export type ExtractionMap = ExtractMap;
export type ExtractionResult<M extends ExtractMap> = ExtractedMap<M>;

export interface EncodingOptions { defaultEncoding?: string; transportLayerEncodingLabel?: string | null; userEncoding?: string; maxBytes?: number }
export interface DecodeStreamOptions extends CheerioOptions { encoding?: EncodingOptions }
/** Structural Node/Undici FormData compatibility without importing its package. */
export interface FormDataLike extends Iterable<[string, string | import('node:buffer').Blob]> {
  append(name: string, value: unknown, filename?: string): void;
  get(name: string): string | import('node:buffer').Blob | null;
}
export interface CheerioRequestOptions extends DecodeStreamOptions {
  requestOptions?: {
    method?: string;
    headers?: Record<string, string | string[] | undefined> | string[] | Iterable<[string, string | string[] | undefined]> | Headers | null;
    body?: string | Buffer | Uint8Array | import('node:stream').Readable | FormData | FormDataLike | null;
    query?: import('node:querystring').ParsedUrlQueryInput;
    onInfo?: (info: { statusCode: number; headers: Record<string, string | string[]> }) => void;
    reset?: boolean;
    typeOfService?: number | null;
    highWaterMark?: number;
    maxRedirections?: number;
    throwOnError?: boolean;
    signal?: unknown;
    headersTimeout?: number | null;
    bodyTimeout?: number | null;
    dispatcher?: unknown;
    [key: string]: unknown;
  };
}
export interface ParallelOptions extends CheerioOptions { threads?: number }
export type SerializedField = { name: string; value: string };
