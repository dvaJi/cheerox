// One adapter per library. Every adapter implements the same three jobs:
//   parse(html)      -> a queryable document (library's own representation)
//   extract(html)    -> { title, desc, links, headings, imgs }   (parse included)
//   serialize(html)  -> HTML string                              (parse included)
// Selector libraries use their own query API; parser-only libraries
// (parse5, htmlparser2) do the equivalent document-order tree walk.
import * as cheerio from 'cheerio';
import * as cheerox from 'cheerox';
import { JSDOM } from 'jsdom';
import * as htmlparser2 from 'htmlparser2';
import * as parse5 from 'parse5';
import { parse as nhpParse } from 'node-html-parser';

export const EXTRACT_MAP = {
  title: 'title',
  desc: { selector: 'meta[name="description"]', value: 'content' },
  links: [{ selector: 'a[href]', value: 'href' }],
  headings: ['h1, h2, h3'],
  imgs: [{ selector: 'img', value: 'tagName' }],
};

const HEADINGS = new Set(['h1', 'h2', 'h3']);

const fromExtract = (o) => ({
  title: o.title,
  desc: o.desc,
  links: o.links,
  headings: o.headings,
  imgs: o.imgs.length,
});

// ---- parse5: spec tree, manual walk ----
function p5Text(node) {
  if (node.nodeName === '#text') return node.value;
  let s = '';
  if (node.childNodes) for (const c of node.childNodes) s += p5Text(c);
  if (node.content) s += p5Text(node.content);
  return s;
}
function p5Extract(doc) {
  const out = { title: undefined, desc: undefined, links: [], headings: [], imgs: 0 };
  const attr = (n, k) => { for (const a of n.attrs) if (a.name === k && !a.prefix) return a.value; return undefined; };
  const walk = (n) => {
    if (n.tagName && n.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      const t = n.tagName;
      if (t === 'title' && out.title === undefined) out.title = p5Text(n);
      else if (t === 'meta' && out.desc === undefined && attr(n, 'name') === 'description') out.desc = attr(n, 'content');
      else if (t === 'a') { const h = attr(n, 'href'); if (h !== undefined) out.links.push(h); }
      else if (t === 'img') out.imgs++;
      if (HEADINGS.has(t)) out.headings.push(p5Text(n));
    }
    if (n.childNodes) for (const c of n.childNodes) walk(c);
  };
  walk(doc);
  return out;
}

// ---- htmlparser2: domhandler tree, manual walk ----
const { DomUtils } = htmlparser2;
function hp2Extract(doc) {
  const out = { title: undefined, desc: undefined, links: [], headings: [], imgs: 0 };
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'tag' || n.type === 'script' || n.type === 'style') {
        const t = n.name;
        if (t === 'title' && out.title === undefined) out.title = DomUtils.textContent(n);
        else if (t === 'meta' && out.desc === undefined && n.attribs.name === 'description') out.desc = n.attribs.content;
        else if (t === 'a' && n.attribs.href !== undefined) out.links.push(n.attribs.href);
        else if (t === 'img') out.imgs++;
        if (HEADINGS.has(t)) out.headings.push(DomUtils.textContent(n));
      }
      if (n.children) walk(n.children);
    }
  };
  walk(doc.children);
  return out;
}

export const LIBS = {
  cheerox: {
    pkg: 'cheerox',
    parse: (html) => cheerox.load(html),
    extract: (html) => fromExtract(cheerox.load(html).extract(EXTRACT_MAP)),
    serialize: (html) => cheerox.load(html).html(),
  },
  cheerio: {
    pkg: 'cheerio',
    parse: (html) => cheerio.load(html),
    extract: (html) => fromExtract(cheerio.load(html).extract(EXTRACT_MAP)),
    serialize: (html) => cheerio.load(html).html(),
  },
  jsdom: {
    pkg: 'jsdom',
    parse: (html) => new JSDOM(html),
    extract: (html) => {
      const dom = new JSDOM(html);
      const d = dom.window.document;
      const out = {
        title: d.querySelector('title')?.textContent ?? undefined,
        desc: d.querySelector('meta[name="description"]')?.getAttribute('content') ?? undefined,
        links: Array.from(d.querySelectorAll('a[href]'), (a) => a.getAttribute('href')),
        headings: Array.from(d.querySelectorAll('h1, h2, h3'), (h) => h.textContent),
        imgs: d.querySelectorAll('img').length,
      };
      dom.window.close();
      return out;
    },
    serialize: (html) => { const dom = new JSDOM(html); const s = dom.serialize(); dom.window.close(); return s; },
  },
  htmlparser2: {
    pkg: 'htmlparser2',
    parse: (html) => htmlparser2.parseDocument(html),
    extract: (html) => hp2Extract(htmlparser2.parseDocument(html)),
    serialize: (html) => DomUtils.getOuterHTML(htmlparser2.parseDocument(html)),
  },
  parse5: {
    pkg: 'parse5',
    parse: (html) => parse5.parse(html),
    extract: (html) => p5Extract(parse5.parse(html)),
    serialize: (html) => parse5.serialize(parse5.parse(html)),
  },
  'node-html-parser': {
    pkg: 'node-html-parser',
    parse: (html) => nhpParse(html),
    extract: (html) => {
      const root = nhpParse(html);
      const t = root.querySelector('title');
      const m = root.querySelector('meta[name="description"]');
      return {
        title: t ? t.text : undefined,
        desc: m ? m.getAttribute('content') : undefined,
        links: root.querySelectorAll('a[href]').map((a) => a.getAttribute('href')),
        headings: root.querySelectorAll('h1, h2, h3').map((h) => h.text),
        imgs: root.querySelectorAll('img').length,
      };
    },
    serialize: (html) => nhpParse(html).toString(),
  },
};

export const LIB_NAMES = Object.keys(LIBS);
