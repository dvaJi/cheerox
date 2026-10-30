import type { AnyNode, ParentNode, ChildNode, Document, Element, Comment, Text, ProcessingInstruction, SourceCodeLocation, TagSourceCodeLocation } from './types.js';

/** Parse5-compatible diagnostics, declared locally without a parser dependency. */
declare enum ERR {
    controlCharacterInInputStream = "control-character-in-input-stream",
    noncharacterInInputStream = "noncharacter-in-input-stream",
    surrogateInInputStream = "surrogate-in-input-stream",
    nonVoidHtmlElementStartTagWithTrailingSolidus = "non-void-html-element-start-tag-with-trailing-solidus",
    endTagWithAttributes = "end-tag-with-attributes",
    endTagWithTrailingSolidus = "end-tag-with-trailing-solidus",
    unexpectedSolidusInTag = "unexpected-solidus-in-tag",
    unexpectedNullCharacter = "unexpected-null-character",
    unexpectedQuestionMarkInsteadOfTagName = "unexpected-question-mark-instead-of-tag-name",
    invalidFirstCharacterOfTagName = "invalid-first-character-of-tag-name",
    unexpectedEqualsSignBeforeAttributeName = "unexpected-equals-sign-before-attribute-name",
    missingEndTagName = "missing-end-tag-name",
    unexpectedCharacterInAttributeName = "unexpected-character-in-attribute-name",
    unknownNamedCharacterReference = "unknown-named-character-reference",
    missingSemicolonAfterCharacterReference = "missing-semicolon-after-character-reference",
    unexpectedCharacterAfterDoctypeSystemIdentifier = "unexpected-character-after-doctype-system-identifier",
    unexpectedCharacterInUnquotedAttributeValue = "unexpected-character-in-unquoted-attribute-value",
    eofBeforeTagName = "eof-before-tag-name",
    eofInTag = "eof-in-tag",
    missingAttributeValue = "missing-attribute-value",
    missingWhitespaceBetweenAttributes = "missing-whitespace-between-attributes",
    missingWhitespaceAfterDoctypePublicKeyword = "missing-whitespace-after-doctype-public-keyword",
    missingWhitespaceBetweenDoctypePublicAndSystemIdentifiers = "missing-whitespace-between-doctype-public-and-system-identifiers",
    missingWhitespaceAfterDoctypeSystemKeyword = "missing-whitespace-after-doctype-system-keyword",
    missingQuoteBeforeDoctypePublicIdentifier = "missing-quote-before-doctype-public-identifier",
    missingQuoteBeforeDoctypeSystemIdentifier = "missing-quote-before-doctype-system-identifier",
    missingDoctypePublicIdentifier = "missing-doctype-public-identifier",
    missingDoctypeSystemIdentifier = "missing-doctype-system-identifier",
    abruptDoctypePublicIdentifier = "abrupt-doctype-public-identifier",
    abruptDoctypeSystemIdentifier = "abrupt-doctype-system-identifier",
    cdataInHtmlContent = "cdata-in-html-content",
    incorrectlyOpenedComment = "incorrectly-opened-comment",
    eofInScriptHtmlCommentLikeText = "eof-in-script-html-comment-like-text",
    eofInDoctype = "eof-in-doctype",
    nestedComment = "nested-comment",
    abruptClosingOfEmptyComment = "abrupt-closing-of-empty-comment",
    eofInComment = "eof-in-comment",
    incorrectlyClosedComment = "incorrectly-closed-comment",
    eofInCdata = "eof-in-cdata",
    absenceOfDigitsInNumericCharacterReference = "absence-of-digits-in-numeric-character-reference",
    nullCharacterReference = "null-character-reference",
    surrogateCharacterReference = "surrogate-character-reference",
    characterReferenceOutsideUnicodeRange = "character-reference-outside-unicode-range",
    controlCharacterReference = "control-character-reference",
    noncharacterCharacterReference = "noncharacter-character-reference",
    missingWhitespaceBeforeDoctypeName = "missing-whitespace-before-doctype-name",
    missingDoctypeName = "missing-doctype-name",
    invalidCharacterSequenceAfterDoctypeName = "invalid-character-sequence-after-doctype-name",
    duplicateAttribute = "duplicate-attribute",
    nonConformingDoctype = "non-conforming-doctype",
    missingDoctype = "missing-doctype",
    misplacedDoctype = "misplaced-doctype",
    endTagWithoutMatchingOpenElement = "end-tag-without-matching-open-element",
    closingOfElementWithOpenChildElements = "closing-of-element-with-open-child-elements",
    disallowedContentInNoscriptInHead = "disallowed-content-in-noscript-in-head",
    openElementsLeftAfterEof = "open-elements-left-after-eof",
    abandonedHeadElementChild = "abandoned-head-element-child",
    misplacedStartTagForHeadElement = "misplaced-start-tag-for-head-element",
    nestedNoscriptInHead = "nested-noscript-in-head",
    eofInElementThatCanContainOnlyText = "eof-in-element-that-can-contain-only-text"
}

export type ParserErrorCode = ERR;
export interface ParserError extends SourceCodeLocation { code: ParserErrorCode }
export type ParserErrorHandler = (error: ParserError) => void;

declare enum NS {
  HTML = 'http://www.w3.org/1999/xhtml',
  MATHML = 'http://www.w3.org/1998/Math/MathML',
  SVG = 'http://www.w3.org/2000/svg',
  XLINK = 'http://www.w3.org/1999/xlink',
  XML = 'http://www.w3.org/XML/1998/namespace',
  XMLNS = 'http://www.w3.org/2000/xmlns/',
}
declare enum DOCUMENT_MODE {
  NO_QUIRKS = 'no-quirks', QUIRKS = 'quirks', LIMITED_QUIRKS = 'limited-quirks',
}
export type NamespaceURI = NS;
export type DocumentMode = DOCUMENT_MODE;
export interface TreeAdapterAttribute { name: string; value: string; namespace?: string; prefix?: string }

/** The HTML5 adapter shape used by Cheerio's DOM representation. */
export interface TreeAdapter {
  adoptAttributes(recipient: Element, attrs: TreeAdapterAttribute[]): void;
  appendChild(parentNode: ParentNode, newNode: ChildNode): void;
  createCommentNode(data: string): Comment;
  createTextNode(value: string): Text;
  createDocument(): Document;
  createDocumentFragment(): Document;
  createElement(tagName: string, namespaceURI: NamespaceURI, attrs: TreeAdapterAttribute[]): Element;
  detachNode(node: ChildNode): void;
  getAttrList(element: Element): TreeAdapterAttribute[];
  getChildNodes(node: ParentNode): ChildNode[];
  getCommentNodeContent(node: Comment): string;
  getDocumentMode(document: Document): DocumentMode;
  getDocumentTypeNodeName(node: ProcessingInstruction): string;
  getDocumentTypeNodePublicId(node: ProcessingInstruction): string;
  getDocumentTypeNodeSystemId(node: ProcessingInstruction): string;
  getFirstChild(node: ParentNode): ChildNode | null;
  getNamespaceURI(element: Element): NamespaceURI;
  getNodeSourceCodeLocation(node: AnyNode): TagSourceCodeLocation | undefined | null;
  getParentNode(node: AnyNode): ParentNode | null;
  getTagName(element: Element): string;
  getTextNodeContent(node: Text): string;
  getTemplateContent(element: Element): Document;
  insertBefore(parent: ParentNode, child: ChildNode, reference: ChildNode): void;
  insertText(parent: ParentNode, text: string): void;
  insertTextBefore(parent: ParentNode, text: string, reference: ChildNode): void;
  isCommentNode(node: AnyNode): node is Comment;
  isDocumentTypeNode(node: AnyNode): node is ProcessingInstruction;
  isElementNode(node: AnyNode): node is Element;
  isTextNode(node: AnyNode): node is Text;
  setDocumentMode(document: Document, mode: DocumentMode): void;
  setDocumentType(document: Document, name: string, publicId: string, systemId: string): void;
  setNodeSourceCodeLocation(node: AnyNode, location: TagSourceCodeLocation | null): void;
  updateNodeSourceCodeLocation(node: AnyNode, location: Partial<TagSourceCodeLocation>): void;
  setTemplateContent(element: Element, content: Document): void;
  onItemPush?: (item: Element) => void;
  onItemPop?: (item: Element, newTop: ParentNode) => void;
}

declare enum QuoteType { NoValue = 0, Unquoted = 1, Single = 2, Double = 3 }
export interface TokenizerCallbacks {
  onattribdata(start: number, endIndex: number): void;
  onattribentity(codepoint: number): void;
  onattribend(quote: QuoteType, endIndex: number): void;
  onattribname(start: number, endIndex: number): void;
  oncdata(start: number, endIndex: number, endOffset: number): void;
  onclosetag(start: number, endIndex: number): void;
  oncomment(start: number, endIndex: number, endOffset: number): void;
  ondeclaration(start: number, endIndex: number): void;
  onend(): void;
  onopentagend(endIndex: number): void;
  onopentagname(start: number, endIndex: number): void;
  onprocessinginstruction(start: number, endIndex: number): void;
  onselfclosingtag(endIndex: number): void;
  ontext(start: number, endIndex: number): void;
  ontextentity(codepoint: number, endIndex: number): void;
}
export interface Tokenizer {
  running: boolean;
  reset(): void;
  write(chunk: string): void;
  end(): void;
  pause(): void;
  resume(): void;
}
export interface TokenizerOptions { xmlMode?: boolean; decodeEntities?: boolean }
export interface TokenizerConstructor {
  new (options: TokenizerOptions, callbacks: TokenizerCallbacks): Tokenizer;
  // The native facade accepts third-party tokenizer classes with private state.
  new (options: TokenizerOptions, callbacks: TokenizerCallbacks): any;
}
