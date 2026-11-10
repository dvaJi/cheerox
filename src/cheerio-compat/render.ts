import { nodeBinding, operation } from '../nodes.js';
import type { LegacyNode, LegacyOptions } from './types.js';

const isTag = (node: LegacyNode): boolean => node.type === 'tag' || node.type === 'script' || node.type === 'style';

/*
 * dom-serializer 0.1.0, over node views.
 */

const unencodedElements: Record<string, boolean | undefined> = { style: true, script: true, xmp: true, iframe: true, noembed: true, noframes: true, plaintext: true, noscript: true };

const singleTag: Record<string, boolean | undefined> = {
  area: true, base: true, basefont: true, br: true, col: true, command: true, embed: true, frame: true,
  hr: true, img: true, input: true, isindex: true, keygen: true, link: true, meta: true, param: true,
  source: true, track: true, wbr: true,
};

const xmlReplacements: Record<string, string> = { '&': '&amp;', "'": '&apos;', '>': '&gt;', '<': '&lt;', '"': '&quot;' };
const encodeXmlRegex = /[&'><"]/g;
const nonAsciiRegex = /[^\0-\x7F]/g;
const astralRegex = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

function codePointReplacement(c: string): string {
  return `&#x${c.codePointAt(0)!.toString(16).toUpperCase()};`;
}

/** entities 1.1 `encodeXML`: the five XML characters plus every non-ASCII rune. */
function encodeXML(data: string): string {
  return data
    .replace(encodeXmlRegex, (c) => xmlReplacements[c])
    .replace(astralRegex, codePointReplacement)
    .replace(nonAsciiRegex, codePointReplacement);
}

function formatAttrs(attribs: Record<string, string> | undefined, opts: LegacyOptions): string {
  if (!attribs) return '';
  let output = '';
  for (const key of Object.keys(attribs)) {
    const value = attribs[key];
    if (output) output += ' ';
    output += key;
    if ((value !== null && value !== '') || opts.xmlMode) {
      output += `="${opts.decodeEntities ? encodeXML(value) : value}"`;
    }
  }
  return output;
}

/**
 * dom-serializer 0.1.x rules run natively (one call per document); nodes
 * outside the engine, or spanning several documents, fall back to the port.
 */
export function renderWith(opts: LegacyOptions, dom: unknown, parentName?: string): string {
  const nodes = Array.isArray(dom) || (dom && typeof dom === 'object' && 'length' in (dom as object))
    ? Array.from(dom as ArrayLike<LegacyNode>)
    : [dom as LegacyNode];
  void parentName;
  if (nodes.length) {
    const bindings = nodes.map((node) => nodeBinding(node));
    const document = bindings[0]?.document;
    if (document && bindings.every((binding) => binding?.document === document)) {
      return operation<string>(document, 'render', {
        ids: bindings.map((binding) => binding!.id),
        // The options go through exactly as 0.22.0's render received them:
        // defaults already applied by the static, `decodeEntities` possibly
        // absent (bare-module `cheerio.xml()` leaves text raw).
        options: { ...opts, _useHtmlParser2: true, legacySerializer: true },
      }) as string;
    }
  }
  let output = '';
  for (const elem of nodes) {
    if (!elem || !elem.type) continue;
    if (elem.type === 'root') output += renderWith(opts, elem.children);
    else if (isTag(elem)) output += renderTag(elem, opts);
    else if (elem.type === 'directive') output += `<${elem.data}>`;
    else if (elem.type === 'comment') output += `<!--${elem.data}-->`;
    else if (elem.type === 'cdata') output += `<![CDATA[${elem.children && elem.children[0] ? elem.children[0].data : ''}]]>`;
    else output += renderText(elem, opts, parentName);
  }
  return output;
}

function renderTag(elem: LegacyNode, opts: LegacyOptions): string {
  // Handle SVG as in 0.22.0: it renders like XML.
  const effective = elem.name === 'svg' ? ({ decodeEntities: opts.decodeEntities, xmlMode: true } as LegacyOptions) : opts;
  let tag = `<${elem.name}`;
  const attribs = formatAttrs(elem.attribs, effective);
  if (attribs) tag += ` ${attribs}`;
  if (effective.xmlMode && (!elem.children || elem.children.length === 0)) {
    tag += '/>';
  } else {
    tag += '>';
    if (elem.children) tag += renderWith(effective, elem.children, elem.name);
    if (!singleTag[elem.name as string] || effective.xmlMode) tag += `</${elem.name}>`;
  }
  return tag;
}

function renderText(elem: LegacyNode, opts: LegacyOptions, parentName?: string): string {
  let data = elem.data || '';
  if (opts.decodeEntities && !(parentName !== undefined && parentName in unencodedElements)) {
    data = encodeXML(data);
  }
  return data;
}
