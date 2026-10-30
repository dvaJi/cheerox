// Executable feature probes. A feature counts only if the probe's code runs
// and produces the expected result. Advanced selectors are scored per selector.
//   node features.mjs
import fs from 'node:fs';
import http from 'node:http';
import { Writable } from 'node:stream';
import * as cheerio from 'cheerio';
import * as rusteerio from 'rusteerio';
import { JSDOM } from 'jsdom';
import * as htmlparser2 from 'htmlparser2';
import * as parse5 from 'parse5';
import { parse as nhpParse } from 'node-html-parser';

const FIXTURE = `<!DOCTYPE html><html><head><title>T</title></head><body>
<div id="main" class="wrap"><p class="x">one</p><p>two</p><p class="x">three</p><span></span></div>
<ul><li><img src="a.png"></li><li>b</li><li>c</li><li>d</li></ul>
<a href="/a">A</a><a>no-href</a><a href="/b" data-x="abc">B</a>
<h1>H1</h1><h2>H2</h2>
<form id="f"><input name="q" value="hi"><input type="checkbox" name="c" value="1" checked><select name="s"><option value="o1">1</option><option value="o2" selected>2</option></select></form>
</body></html>`;

// selector -> expected match count on FIXTURE
const SELECTORS = {
  'div > p.x': 2,
  'p:not(.x)': 1,
  'li:nth-child(2n+1)': 2,
  'li:nth-last-child(2)': 1,
  'li:has(> img)': 1,
  '[data-x^="ab"]': 1,
  'a:not([href])': 1,
  ':is(h1, h2)': 2,
  'p:first-of-type': 1,
  'span:empty': 1,
  'input:checked': 1,
  'h1 ~ h2': 1,
  'h1 + h2': 1,
  'a[href$="/b"]': 1,
  'li:last-child': 1,
};

function selectorScore(qsa) {
  let ok = 0;
  for (const [sel, n] of Object.entries(SELECTORS)) {
    try { if (qsa(sel) === n) ok++; } catch {}
  }
  return ok / Object.keys(SELECTORS).length;
}

const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<title>served</title>'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/`;

// windows-1252 bytes for "<meta charset=windows-1252><p>café</p>"
const LATIN1 = Buffer.concat([Buffer.from('<meta charset="windows-1252"><p>caf'), Buffer.from([0xe9]), Buffer.from('</p>')]);

const streamProbe = (make) => new Promise((resolve) => {
  try {
    const s = make((text) => resolve(text === 'streamed'));
    s.write('<html><body><p>str'); s.write('eamed</p></body></html>'); s.end();
    setTimeout(() => resolve(false), 2000);
  } catch { resolve(false); }
});

const pkgJson = (name) => JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, 'utf8'));
const hasTypes = (name) => { const p = pkgJson(name); return Boolean(p.types || p.typings || JSON.stringify(p.exports ?? {}).includes('"types"')); };
const zeroDeps = (name) => Object.keys(pkgJson(name).dependencies ?? {}).length === 0;

async function probe(fn) { try { return Boolean(await fn()); } catch { return false; } }

// cheerio-API libraries share probes
const cheerioLike = (lib, name) => ({
  css_basic: () => lib.load(FIXTURE)('div > p.x').length === 2,
  css_advanced: () => { const $ = lib.load(FIXTURE); return selectorScore((s) => $(s).length); },
  jquery_api: () => { const $ = lib.load(FIXTURE); $('#main').find('p').addClass('y').attr('data-k', '1'); return $('p.y[data-k="1"]').length === 3; },
  dom_mutation: () => { const $ = lib.load(FIXTURE); $('ul').append('<li id="new">e</li>'); $('a').first().remove(); return $('#new').length === 1 && $('a').length === 2 && $.html().includes('<li id="new">e</li>'); },
  serialize: () => lib.load('<p>x</p>').html() === '<html><head></head><body><p>x</p></body></html>',
  text: () => lib.load(FIXTURE)('#main').text() === 'onetwothree',
  xml_mode: () => { const $ = lib.load('<Root><Item Id="1"/></Root>', { xml: true }); return $('Item').attr('Id') === '1' && $.xml().includes('<Item Id="1"/>'); },
  streaming: () => streamProbe((done) => lib.stringStream({}, (err, $) => done($('p').text()))),
  encoding_sniff: () => lib.loadBuffer(LATIN1)('p').text() === 'café',
  fetch_url: async () => (await lib.fromURL(URL_))('title').text() === 'served',
  source_locations: () => { const $ = lib.load('<p>x</p>', { sourceCodeLocationInfo: true }); return $('p')[0].sourceCodeLocation?.startOffset === 0; },
  declarative_extract: () => JSON.stringify(lib.load(FIXTURE).extract({ links: [{ selector: 'a[href]', value: 'href' }] })) === '{"links":["/a","/b"]}',
  form_serialize: () => lib.load(FIXTURE)('#f').serialize() === 'q=hi&c=1&s=o2',
  style_api: () => { const $ = lib.load('<p style="color: red">x</p>'); $('p').css('margin', '0'); return $('p').css('color') === 'red' && $('p').attr('style').includes('margin: 0'); },
  async_offthread_parse: async () => typeof lib.loadAsync === 'function' && (await lib.loadAsync(FIXTURE))('li').length === 4,
  native_multicore: async () => typeof lib.extractAll === 'function' && (await lib.extractAll([FIXTURE, FIXTURE], { t: 'title' }, { threads: 2 })).length === 2,
  script_execution: () => false,
  parse_errors: () => { const errs = []; lib.load('<p></b>', { onParseError: (e) => errs.push(e) }); return errs.length > 0; },
  fragment_parsing: () => lib.load('<b>x</b>', null, false).html() === '<b>x</b>',
  events_api: () => false,
  typescript_types: () => hasTypes(name),
  zero_runtime_deps: () => zeroDeps(name),
});

const P = {
  rusteerio: cheerioLike(rusteerio, 'rusteerio'),
  cheerio: cheerioLike(cheerio, 'cheerio'),
  jsdom: {
    css_basic: () => new JSDOM(FIXTURE).window.document.querySelectorAll('div > p.x').length === 2,
    css_advanced: () => { const d = new JSDOM(FIXTURE).window.document; return selectorScore((s) => d.querySelectorAll(s).length); },
    jquery_api: () => false,
    dom_mutation: () => { const dom = new JSDOM(FIXTURE); const d = dom.window.document; const li = d.createElement('li'); li.id = 'new'; li.textContent = 'e'; d.querySelector('ul').append(li); d.querySelector('a').remove(); return d.querySelectorAll('a').length === 2 && dom.serialize().includes('<li id="new">e</li>'); },
    serialize: () => new JSDOM('<p>x</p>').serialize() === '<html><head></head><body><p>x</p></body></html>',
    text: () => new JSDOM(FIXTURE).window.document.getElementById('main').textContent === 'onetwothree',
    xml_mode: () => { const d = new JSDOM('<Root><Item Id="1"/></Root>', { contentType: 'text/xml' }); return d.window.document.querySelector('Item').getAttribute('Id') === '1' && d.serialize().includes('<Item Id="1"/>'); },
    streaming: () => false,
    encoding_sniff: () => new JSDOM(LATIN1).window.document.querySelector('p').textContent === 'café',
    fetch_url: async () => (await JSDOM.fromURL(URL_)).window.document.title === 'served',
    source_locations: () => { const dom = new JSDOM('<p>x</p>', { includeNodeLocations: true }); return dom.nodeLocation(dom.window.document.querySelector('p')).startOffset === 0; },
    declarative_extract: () => false,
    form_serialize: () => { const w = new JSDOM(FIXTURE).window; return new w.URLSearchParams(new w.FormData(w.document.getElementById('f'))).toString() === 'q=hi&c=1&s=o2'; },
    style_api: () => { const d = new JSDOM('<p style="color: red">x</p>').window.document; const p = d.querySelector('p'); p.style.margin = '0'; return p.style.color === 'red' && p.getAttribute('style').includes('margin: 0'); },
    async_offthread_parse: () => false,
    native_multicore: () => false,
    script_execution: () => new JSDOM('<p id=o></p><script>document.getElementById("o").textContent = "ran"</script>', { runScripts: 'dangerously' }).window.document.getElementById('o').textContent === 'ran',
    parse_errors: () => false,
    fragment_parsing: () => JSDOM.fragment('<b>x</b>').firstChild.outerHTML === '<b>x</b>',
    events_api: () => { const w = new JSDOM('<button>x</button>').window; let hit = 0; const b = w.document.querySelector('button'); b.addEventListener('click', () => hit++); b.click(); return hit === 1; },
    typescript_types: () => hasTypes('jsdom'),
    zero_runtime_deps: () => zeroDeps('jsdom'),
  },
  htmlparser2: {
    css_basic: () => false, css_advanced: () => 0, jquery_api: () => false,
    dom_mutation: () => { const { DomUtils } = htmlparser2; const doc = htmlparser2.parseDocument('<ul><li>a</li></ul><a>x</a>'); const ul = DomUtils.findOne((e) => e.name === 'ul', doc.children); DomUtils.appendChild(ul, htmlparser2.parseDocument('<li id="new">e</li>').children[0]); DomUtils.removeElement(DomUtils.findOne((e) => e.name === 'a', doc.children)); return DomUtils.getOuterHTML(doc) === '<ul><li>a</li><li id="new">e</li></ul>'; },
    serialize: () => htmlparser2.DomUtils.getOuterHTML(htmlparser2.parseDocument('<p>x</p>')) === '<p>x</p>',
    text: () => { const { DomUtils } = htmlparser2; const doc = htmlparser2.parseDocument(FIXTURE); return DomUtils.textContent(DomUtils.getElementById('main', doc.children)) === 'onetwothree'; },
    xml_mode: () => { const doc = htmlparser2.parseDocument('<Root><Item Id="1"/></Root>', { xmlMode: true }); return doc.children[0].children[0].attribs.Id === '1' && htmlparser2.DomUtils.getOuterHTML(doc, { xmlMode: true }).includes('<Item Id="1"/>'); },
    streaming: () => streamProbe((done) => { const h = new htmlparser2.DomHandler((e, dom) => done(htmlparser2.DomUtils.textContent(htmlparser2.DomUtils.findOne((x) => x.name === 'p', dom)))); const p = new htmlparser2.Parser(h); return { write: (s) => p.write(s), end: () => p.end() }; }),
    encoding_sniff: () => false, fetch_url: () => false,
    source_locations: () => htmlparser2.parseDocument('<div><p>x</p></div>', { withStartIndices: true, withEndIndices: true }).children[0].children[0].startIndex === 5,
    declarative_extract: () => false, form_serialize: () => false, style_api: () => false,
    async_offthread_parse: () => false, native_multicore: () => false, script_execution: () => false,
    parse_errors: () => false,
    fragment_parsing: () => htmlparser2.DomUtils.getOuterHTML(htmlparser2.parseDocument('<b>x</b>')) === '<b>x</b>',
    events_api: () => false,
    typescript_types: () => hasTypes('htmlparser2'), zero_runtime_deps: () => zeroDeps('htmlparser2'),
  },
  parse5: {
    css_basic: () => false, css_advanced: () => 0, jquery_api: () => false,
    dom_mutation: () => { const doc = parse5.parse('<ul><li>a</li></ul>'); const { defaultTreeAdapter: A } = parse5; const body = doc.childNodes[0].childNodes[1]; const ul = body.childNodes[0]; const li = A.createElement('li', 'http://www.w3.org/1999/xhtml', [{ name: 'id', value: 'new' }]); A.insertText(li, 'e'); A.appendChild(ul, li); return parse5.serialize(doc).includes('<li id="new">e</li>'); },
    serialize: () => parse5.serialize(parse5.parse('<p>x</p>')) === '<html><head></head><body><p>x</p></body></html>',
    text: () => false,
    xml_mode: () => false,
    streaming: () => false,
    encoding_sniff: () => false, fetch_url: () => false,
    source_locations: () => parse5.parse('<p>x</p>', { sourceCodeLocationInfo: true }).childNodes[0].childNodes[1].childNodes[0].sourceCodeLocation.startOffset === 0,
    declarative_extract: () => false, form_serialize: () => false, style_api: () => false,
    async_offthread_parse: () => false, native_multicore: () => false, script_execution: () => false,
    parse_errors: () => { const errs = []; parse5.parse('<p></b>', { onParseError: (e) => errs.push(e) }); return errs.length > 0; },
    fragment_parsing: () => parse5.serialize(parse5.parseFragment('<b>x</b>')) === '<b>x</b>',
    events_api: () => false,
    typescript_types: () => hasTypes('parse5'), zero_runtime_deps: () => zeroDeps('parse5'),
  },
  'node-html-parser': {
    css_basic: () => nhpParse(FIXTURE).querySelectorAll('div > p.x').length === 2,
    css_advanced: () => { const r = nhpParse(FIXTURE); return selectorScore((s) => r.querySelectorAll(s).length); },
    jquery_api: () => false,
    dom_mutation: () => { const r = nhpParse(FIXTURE); r.querySelector('ul').appendChild(nhpParse('<li id="new">e</li>').firstChild); r.querySelector('a').remove(); return r.querySelectorAll('a').length === 2 && r.toString().includes('<li id="new">e</li>'); },
    serialize: () => nhpParse('<p>x</p>').toString() === '<p>x</p>',
    text: () => nhpParse(FIXTURE).getElementById('main').text === 'onetwothree',
    xml_mode: () => false,
    streaming: () => false, encoding_sniff: () => false, fetch_url: () => false,
    source_locations: () => { const r = nhpParse('<div><p>x</p></div>'); return r.querySelector('p').range?.[0] === 5; },
    declarative_extract: () => false, form_serialize: () => false, style_api: () => false,
    async_offthread_parse: () => false, native_multicore: () => false, script_execution: () => false,
    parse_errors: () => false,
    fragment_parsing: () => nhpParse('<b>x</b>').toString() === '<b>x</b>',
    events_api: () => false,
    typescript_types: () => hasTypes('node-html-parser'), zero_runtime_deps: () => zeroDeps('node-html-parser'),
  },
};

const FEATURES = Object.keys(P.rusteerio);
const results = {};
for (const [lib, probes] of Object.entries(P)) {
  results[lib] = {};
  for (const f of FEATURES) {
    if (f === 'css_advanced') { try { results[lib][f] = +(await probes[f]()).toFixed(3); } catch { results[lib][f] = 0; } }
    else results[lib][f] = await probe(probes[f]);
  }
  results[lib].score = +FEATURES.reduce((s, f) => s + Number(results[lib][f]), 0).toFixed(2);
}
server.close();
console.log(JSON.stringify({ features: FEATURES, selectors: SELECTORS, maxScore: FEATURES.length, results }));
