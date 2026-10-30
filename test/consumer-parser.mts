import * as cheerox from '@dvaji/cheerox/modern';
import { Tokenizer as ReferenceTokenizer } from 'htmlparser2-modern';
import { adapter } from 'parse5-htmlparser2-tree-adapter';
import type { ParserError as ReferenceParserError } from 'parse5';

const typedAdapter: cheerox.TreeAdapter = {
  ...adapter,
  createElement(name, namespace, attributes) {
    const tag: string = name;
    const value: string | undefined = attributes[0]?.value;
    // @ts-expect-error Adapter arguments retain concrete types.
    const invalidTag: number = name;
    // @ts-expect-error Attribute names are strings.
    const invalidAttribute: number = attributes[0].name;
    void [tag, value, invalidTag, invalidAttribute];
    return adapter.createElement(name, namespace, attributes);
  },
  onItemPush(element) {
    const name: string = element.name;
    // @ts-expect-error The stack callback receives an element.
    const invalid: number = element.name;
    void [name, invalid];
  },
  onItemPop(_element, newTop) {
    const parent: cheerox.ParentNode = newTop;
    void parent;
  },
};
const upstreamAdapter: typeof adapter = typedAdapter;
const importedAdapter: cheerox.TreeAdapter = adapter;

cheerox.load('<p>typed hooks', {
  treeAdapter: typedAdapter,
  onParseError(error) {
    const offset: number = error.startOffset;
    const code: cheerox.ParserErrorCode = error.code;
    const upstreamError: ReferenceParserError = error;
    // @ts-expect-error Parser diagnostics are typed without any.
    const invalidOffset: string = error.startOffset;
    // @ts-expect-error Only declared diagnostic fields are accessible.
    void error.unknownDiagnosticField;
    void [offset, code, upstreamError, invalidOffset];
  },
});
declare const upstreamError: ReferenceParserError;
const importedError: cheerox.ParserError = upstreamError;

const callbacks: cheerox.TokenizerCallbacks = {
  ...({} as cheerox.TokenizerCallbacks),
  ontext(start, endIndex) {
    const offset: number = start;
    // @ts-expect-error Tokenizer positions are numbers.
    const invalid: string = endIndex;
    void [offset, invalid];
  },
};
const Constructor: cheerox.TokenizerConstructor = ReferenceTokenizer;
const upstreamConstructor: typeof ReferenceTokenizer = Constructor;
const tokenizer = new Constructor({}, callbacks);
const running: boolean = tokenizer.running;
// @ts-expect-error The precise constructor overload keeps instance fields typed.
const invalidRunning: number = tokenizer.running;
tokenizer.write('typed');
class CustomTokenizer extends ReferenceTokenizer {
  constructor(options: cheerox.TokenizerOptions, callbacks: cheerox.TokenizerCallbacks) { super(options, callbacks); }
}
cheerox.load('<Root/>', { xml: { Tokenizer: CustomTokenizer } });
// @ts-expect-error Parser error code aliases have no phantom runtime export.
void cheerox.ParserErrorCode;
void [upstreamAdapter, importedAdapter, importedError, upstreamConstructor, running, invalidRunning];
