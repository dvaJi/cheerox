import { requireNative } from './native.js';
import { getNode, importNodes, nodeBinding, operation } from './nodes.js';
import { routeDocument } from './router.js';
import { parseNativeDocument, cleanParserOptions } from './hooks.js';
import type { AnyNode, Document, InternalOptions, ParentNode } from './types.js';

type ParseContent = string | Buffer | Document | AnyNode | AnyNode[];
type Parser = (content: string, options: InternalOptions, isDocument: boolean, context: ParentNode | null) => Document;

/** Parse with the Rust HTML5 or HTML/XML engine, preserving fragment context. */
function parseWithNative(content: string, options: InternalOptions, isDocument: boolean, context: ParentNode | null): Document {
  if (!isDocument && context) {
    const document = nodeBinding(context)?.document
      ?? routeDocument(new (requireNative().NativeDocument)('', false, JSON.stringify(cleanParserOptions(options))), options);
    const contextId = importNodes(document, [context])[0];
    const children = operation<number[]>(document, 'create', { html: content, contextId, options });
    const root = operation<number>(document, 'createNode', { type: 'root', options });
    operation(document, 'setNode', { id: root, field: 'children', value: children, options });
    return getNode(document, root) as Document;
  }
  const document = parseNativeDocument(content, options, isDocument);
  return getNode(document, document.rootId()) as Document;
}

/** The HTML5 adapter uses Rust's HTML5 tree builder. */
export function parseWithParse5(content: string, options: InternalOptions, isDocument: boolean, context: ParentNode | null): Document {
  return parseWithNative(content, { ...options, _useHtmlParser2: false, xml: false, xmlMode: false }, isDocument, context);
}

/** The htmlparser2-compatible adapter uses the Rust HTML/XML tokenizer. */
export function parseWithHtmlparser2(content: string, options: InternalOptions): Document {
  return parseWithNative(content, { ...options, _useHtmlParser2: true }, false, null);
}

export { parseWithHtmlparser2 as parseDocument };

/** Normalize parser inputs while keeping every DOM operation in the native arena. */
export function getParse(parser: Parser) {
  return function parse(content: ParseContent, options: InternalOptions, isDocument: boolean, context: ParentNode | null): Document {
    if (Buffer.isBuffer(content)) content = content.toString();
    if (typeof content === 'string') return parser(content, options, isDocument, context);
    if (!Array.isArray(content) && content.type === 'root' && nodeBinding(content)) return content;
    const document = routeDocument(new (requireNative().NativeDocument)('', false, JSON.stringify(cleanParserOptions(options))), options);
    const ids = importNodes(document, content);
    if (!Array.isArray(content) && content.type === 'root') return getNode(document, ids[0]) as Document;
    operation(document, 'setNode', { id: document.rootId(), field: 'children', value: ids, options });
    return getNode(document, document.rootId()) as Document;
  };
}

export const parse = getParse((content, options, isDocument, context) => options._useHtmlParser2
  ? parseWithHtmlparser2(content, options)
  : parseWithParse5(content, options, isDocument, context));
