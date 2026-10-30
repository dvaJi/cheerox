// WHATWG tree-construction conformance using the html5lib-format tests in
// web-platform-tests (html/syntax/parsing/resources/*.dat).
//   node html5lib.mjs <wpt-root>
// Each library's own public tree is normalised and printed in html5lib format.
// Scored: whole-document tests without #script-on/#script-off flags, excluding
// scripted_* and pending-spec-changes* files. "strict" compares the full tree;
// "lenient" also ignores attribute namespaces/prefixes.
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import * as cheerox from 'cheerox';
import { JSDOM } from 'jsdom';
import * as htmlparser2 from 'htmlparser2';
import * as parse5 from 'parse5';
import { parse as nhpParse } from 'node-html-parser';

const root = process.argv[2];
const dir = path.join(root, 'html/syntax/parsing/resources');
const HEADERS = new Set(['#data', '#errors', '#new-errors', '#document-fragment', '#document', '#script-off', '#script-on']);

function readTests(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const tests = [];
  let cur = null, sec = null;
  for (const line of lines) {
    if (HEADERS.has(line) && (line !== '#data' || sec === null || sec === '#document')) {
      if (line === '#data') { cur = { file: path.basename(file) }; tests.push(cur); }
      sec = line; cur[sec] = [];
      continue;
    }
    if (cur && sec) cur[sec].push(line);
  }
  return tests.map((t) => ({
    file: t.file,
    data: (t['#data'] ?? []).join('\n'),
    fragment: '#document-fragment' in t,
    flagged: '#script-on' in t || '#script-off' in t,
    expected: (t['#document'] ?? []).join('\n').replace(/\n+$/, ''),
  }));
}

const NS = { 'http://www.w3.org/2000/svg': 'svg', 'http://www.w3.org/1998/Math/MathML': 'math' };
const ATTR_NS = { 'http://www.w3.org/1999/xlink': 'xlink', 'http://www.w3.org/XML/1998/namespace': 'xml', 'http://www.w3.org/2000/xmlns/': 'xmlns' };

// Normalised node: {t:'doctype',name,pub,sys} | {t:'comment',v} | {t:'text',v}
//                  | {t:'el',ns,name,attrs:[{n,ns,v}],kids,content?}
function print(nodes, lenient) {
  const out = [];
  const walk = (list, d) => {
    // merge adjacent text nodes (lenient for every library alike)
    const merged = [];
    for (const n of list) {
      if (n.t === 'text' && merged.at(-1)?.t === 'text') merged.at(-1).v += n.v;
      else merged.push(n.t === 'text' ? { ...n } : n);
    }
    for (const n of merged) {
      const p = '| ' + '  '.repeat(d);
      if (n.t === 'doctype') {
        out.push(p + (n.pub || n.sys ? `<!DOCTYPE ${n.name} "${n.pub}" "${n.sys}">` : `<!DOCTYPE ${n.name}>`));
      } else if (n.t === 'comment') out.push(`${p}<!-- ${n.v} -->`);
      else if (n.t === 'text') { if (n.v !== '') out.push(`${p}"${n.v}"`); }
      else if (n.t === 'el') {
        out.push(`${p}<${NS[n.ns] ? NS[n.ns] + ' ' : ''}${n.name}>`);
        const attrs = n.attrs.map((a) => [!lenient && ATTR_NS[a.ns] ? `${ATTR_NS[a.ns]} ${a.n}` : a.n, a.v]);
        attrs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        for (const [k, v] of attrs) out.push(`${p}  ${k}="${v}"`);
        if (n.content) { out.push(`${p}  content`); walk(n.content, d + 2); }
        walk(n.kids, d + 1);
      }
    }
  };
  walk(nodes, 0);
  return out.join('\n');
}
// html5lib expected output: lenient mode also strips attribute namespace prefixes
const stripAttrNs = (s) => s.replace(/^(\|\s+)(xlink|xml|xmlns) (\S+=")/gm, (m, p, ns, rest) => (ns === 'xmlns' && rest.startsWith('xmlns=') ? m : p + rest));

// ---------- adapters: library tree -> normalised tree ----------
const HTML = 'http://www.w3.org/1999/xhtml';

function fromParse5(nodes) {
  return nodes.map((n) => {
    if (n.nodeName === '#documentType') return { t: 'doctype', name: n.name, pub: n.publicId ?? '', sys: n.systemId ?? '' };
    if (n.nodeName === '#comment') return { t: 'comment', v: n.data };
    if (n.nodeName === '#text') return { t: 'text', v: n.value };
    return {
      t: 'el', ns: n.namespaceURI, name: n.tagName,
      attrs: n.attrs.map((a) => ({ n: a.name, ns: a.namespace, v: a.value })),
      kids: fromParse5(n.childNodes),
      content: n.content ? fromParse5(n.content.childNodes) : undefined,
    };
  });
}

function doctypeFromDirective(n) {
  if (n['x-name'] !== undefined) return { t: 'doctype', name: n['x-name'] ?? '', pub: n['x-publicId'] ?? '', sys: n['x-systemId'] ?? '' };
  const m = /^!doctype\s*([^\s>]*)\s*(?:public\s*["']([^"']*)["']\s*(?:["']([^"']*)["'])?|system\s*["']([^"']*)["'])?/i.exec(n.data);
  return { t: 'doctype', name: (m?.[1] ?? '').toLowerCase(), pub: m?.[2] ?? '', sys: m?.[3] ?? m?.[4] ?? '' };
}

function fromDomhandler(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'directive') { if (/^!doctype/i.test(n.name)) out.push(doctypeFromDirective(n)); continue; }
    if (n.type === 'comment') { out.push({ t: 'comment', v: n.data }); continue; }
    if (n.type === 'text') { out.push({ t: 'text', v: n.data }); continue; }
    if (n.type === 'cdata') { out.push(...fromDomhandler(n.children)); continue; }
    if (n.type === 'tag' || n.type === 'script' || n.type === 'style') {
      const nsMap = n['x-attribsNamespace'] ?? {};
      const isTemplate = n.name === 'template' && (n.namespace ?? HTML) === HTML && n.children[0]?.type === 'root';
      out.push({
        t: 'el', ns: n.namespace ?? HTML, name: n.name,
        attrs: Object.keys(n.attribs).map((k) => ({ n: k, ns: nsMap[k], v: n.attribs[k] })),
        kids: isTemplate ? [] : fromDomhandler(n.children),
        content: isTemplate ? fromDomhandler(n.children[0].children) : undefined,
      });
    }
  }
  return out;
}

function fromDOM(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.nodeType === 10) out.push({ t: 'doctype', name: n.name, pub: n.publicId, sys: n.systemId });
    else if (n.nodeType === 8) out.push({ t: 'comment', v: n.data });
    else if (n.nodeType === 3 || n.nodeType === 4) out.push({ t: 'text', v: n.data });
    else if (n.nodeType === 1) out.push({
      t: 'el', ns: n.namespaceURI, name: n.localName,
      attrs: Array.from(n.attributes, (a) => ({ n: a.localName, ns: a.namespaceURI, v: a.value })),
      kids: fromDOM(n.childNodes),
      content: n.localName === 'template' && n.namespaceURI === HTML ? fromDOM(n.content.childNodes) : undefined,
    });
  }
  return out;
}

function fromNHP(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.nodeType === 8) out.push({ t: 'comment', v: n.rawText });
    else if (n.nodeType === 3) out.push({ t: 'text', v: n.text });
    else if (n.nodeType === 1) out.push({
      t: 'el', ns: HTML, name: n.rawTagName?.toLowerCase(),
      attrs: Object.entries(n.attributes).map(([k, v]) => ({ n: k.toLowerCase(), v })),
      kids: fromNHP(n.childNodes),
    });
  }
  return out;
}

const LIBS = {
  cheerox: (h) => fromDomhandler(cheerox.load(h).root()[0].children),
  cheerio: (h) => fromDomhandler(cheerio.load(h).root()[0].children),
  jsdom: (h) => { const d = new JSDOM(h); const t = fromDOM(d.window.document.childNodes); d.window.close(); return t; },
  htmlparser2: (h) => fromDomhandler(htmlparser2.parseDocument(h).children),
  parse5: (h) => fromParse5(parse5.parse(h).childNodes),
  'node-html-parser': (h) => fromNHP(nhpParse(h, { comment: true }).childNodes),
};

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.dat') && !f.startsWith('scripted_') && !f.startsWith('pending-spec-changes')).sort();
const tests = files.flatMap((f) => readTests(path.join(dir, f))).filter((t) => !t.fragment && !t.flagged);

const summary = {};
const failures = {};
for (const [name, fn] of Object.entries(LIBS)) {
  let strict = 0, lenient = 0, crashed = 0;
  const perFile = {};
  failures[name] = [];
  for (const t of tests) {
    perFile[t.file] ??= { total: 0, pass: 0 };
    perFile[t.file].total++;
    let tree;
    try { tree = fn(t.data); } catch { crashed++; continue; }
    const s = print(tree, false) === t.expected;
    const l = s || print(tree, true) === stripAttrNs(t.expected);
    if (s) { strict++; perFile[t.file].pass++; }
    if (l) lenient++;
    if (!l && failures[name].length < 15) failures[name].push({ file: t.file, data: t.data.slice(0, 200), got: print(tree, true).slice(0, 400), want: t.expected.slice(0, 400) });
  }
  summary[name] = {
    total: tests.length, strictPass: strict, lenientPass: lenient, crashed,
    strictPct: +(100 * strict / tests.length).toFixed(2), lenientPct: +(100 * lenient / tests.length).toFixed(2), perFile,
  };
}
fs.mkdirSync('results', { recursive: true });
fs.writeFileSync('results/html5lib_failures.json', JSON.stringify(failures, null, 1));
console.log(JSON.stringify({ suite: 'wpt html/syntax/parsing/resources/*.dat', files: files.length, tests: tests.length, summary }));
