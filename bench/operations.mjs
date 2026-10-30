import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import * as rusteerio from '../dist/modern.mjs';

/**
 * Per-operation comparison on freshly loaded documents. Each sample loads a
 * new document outside the timed section, then times one operation, so lazy
 * work an engine defers to first use is charged to that operation. Every
 * operation's output must be identical across engines.
 *
 *   node bench/operations.mjs [--quick] [--corpus dir] [--json out.json] [--only name,...]
 */
const args = process.argv.slice(2);
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const isQuick = args.includes('--quick');
const only = flag('--only')?.split(',');
const corpusDirectory = flag('--corpus');
const samples = isQuick ? 7 : 21;
const modes = { html: undefined, xml: { xml: true }, htmlparser2: { xml: { xmlMode: false } } };
const loadOptions = modes[flag('--mode') ?? 'html'];

function generatedPage(cards) {
  const card = (i) => `<div class="card c${i % 7}" id="d${i}" data-index="${i}"><header><a href="/p/${i}" title="Item ${i}"><img src="/i/${i}.png" alt="x${i}" width="10"></a></header><p>Lorem ipsum ${i} <b>bold</b> &amp; <i>more</i></p><ul><li>a</li><li class="x">b</li></ul></div>`;
  return `<!doctype html><html><head><title>Page</title><meta name="description" content="d"><script>var x = 1 < 2;</script></head><body><nav><a href="/">Home</a></nav><main>${Array.from({ length: cards }, (_, i) => card(i)).join('')}</main><footer>f</footer></body></html>`;
}

const walk = (node, visit) => { visit(node); const children = node.children; if (children) for (let i = 0; i < children.length; i++) walk(children[i], visit); };

/** Each operation returns a value both engines must produce identically. */
const operations = {
  'select by tag': ($) => $('a').length,
  'select compound': ($) => $('div.card > header a[href]').length,
  'text of selection': ($) => $('p').text(),
  'html of selection': ($) => $('ul').first().html(),
  'serialize document': ($) => $.html().length,
  'attr via each': ($) => { const values = []; $('img').each((_, element) => { values.push($(element).attr('src')); }); return values; },
  'attribs property': ($) => $('a').toArray().map((element) => element.attribs.href),
  'map and get': ($) => $('a').map((_, element) => $(element).attr('title')).get(),
  'closest from elements': ($) => $('img').map((_, element) => $(element).closest('div').attr('id')).get(),
  'parents count': ($) => $('li').toArray().reduce((total, element) => total + $(element).parents().length, 0),
  'parent and siblings': ($) => $('b').toArray().reduce((total, element) => total + $(element).parent().siblings().length, 0),
  'children and next': ($) => $('ul').toArray().reduce((total, element) => total + $(element).children().first().next().length, 0),
  'find from each element': ($) => $('div.card').toArray().reduce((total, element) => total + $(element).find('li.x').length, 0),
  'is and filter': ($) => $('li').filter('.x').length + $('div').toArray().filter((element) => $(element).is('.c3')).length,
  'walk children': ($) => { let count = 0; walk($.root()[0], () => { count++; }); return count; },
  'walk with fields': ($) => { let total = 0; walk($.root()[0], (node) => { if (node.type === 'tag') total += node.name.length + Object.keys(node.attribs).length; else if (node.type === 'text') total += node.data.length; }); return total; },
  'contents and text nodes': ($) => $('p').contents().filter((_, node) => node.type === 'text').length,
  'set attributes': ($) => { $('img').attr('data-seen', '1').addClass('seen'); return $('img.seen').length; },
  'remove elements': ($) => { $('script, footer, li.x').remove(); return $('*').length; },
  'append and prepend': ($) => { $('div.card').append('<span class="added">+</span>').prepend('<em>-</em>'); return $('span.added').length; },
  'replace text and html': ($) => { $('i').text('changed'); $('b').html('<u>u</u>'); return $('u').length; },
  'mutate then serialize': ($) => { $('a').attr('rel', 'nofollow'); $('ul').remove(); return $('main').html().length; },
  'per-element attribute rewrite': ($) => { $('a').each((_, element) => { $(element).attr('href', `https://example.com${element.attribs.href}`); }); return $('a').last().attr('href'); },
  'clone and insert': ($) => { const copy = $('header').first().clone(); $('footer').append(copy); return $('footer a').length; },
  'extract map': ($) => $.extract({ links: [{ selector: 'a', value: 'href' }], title: 'title' }),
};

function measure(engine, html, operation, options = loadOptions) {
  const times = [];
  let output;
  for (let sample = 0; sample < samples + 2; sample++) {
    const $ = engine.load(html, options);
    const start = process.hrtime.bigint();
    const result = operation($);
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    if (sample >= 2) times.push(elapsed);
    output = result;
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)], output };
}

function measureLoad(engine, html, options = loadOptions) {
  const times = [];
  for (let sample = 0; sample < samples + 2; sample++) {
    const start = process.hrtime.bigint();
    engine.load(html, options);
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    if (sample >= 2) times.push(elapsed);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

const pages = corpusDirectory
  ? readdirSync(corpusDirectory).filter((name) => name.endsWith('.html')).sort().map((name) => ({ name, html: readFileSync(path.join(corpusDirectory, name), 'utf8') }))
  : [{ name: 'generated-200', html: generatedPage(200) }, { name: 'generated-2000', html: generatedPage(2000) }];

const rows = [];
for (const page of pages) {
  const cheerioLoad = measureLoad(cheerio, page.html);
  const rusteerioLoad = measureLoad(rusteerio, page.html);
  rows.push({ page: page.name, operation: 'load', cheerio: cheerioLoad, rusteerio: rusteerioLoad });
  for (const [name, operation] of Object.entries(operations)) {
    if (only && !only.includes(name)) continue;
    const reference = measure(cheerio, page.html, operation);
    const candidate = measure(rusteerio, page.html, operation);
    assert.deepEqual(candidate.output, reference.output, `${name} output differs on ${page.name}`);
    rows.push({ page: page.name, operation: name, cheerio: reference.median, rusteerio: candidate.median, cheerioWithLoad: reference.median + cheerioLoad, rusteerioWithLoad: candidate.median + rusteerioLoad });
  }
}

const format = (value) => value < 0.1 ? value.toFixed(3) : value.toFixed(2);
console.log(`${'page'.padEnd(16)} ${'operation'.padEnd(30)} ${'cheerio ms'.padStart(11)} ${'rusteerio ms'.padStart(13)} ${'speedup'.padStart(8)} ${'with load'.padStart(10)}`);
for (const row of rows) {
  const withLoad = row.cheerioWithLoad ? `${(row.cheerioWithLoad / row.rusteerioWithLoad).toFixed(2)}x` : '';
  console.log(`${row.page.padEnd(16)} ${row.operation.padEnd(30)} ${format(row.cheerio).padStart(11)} ${format(row.rusteerio).padStart(13)} ${`${(row.cheerio / row.rusteerio).toFixed(2)}x`.padStart(8)} ${withLoad.padStart(10)}`);
}
const json = flag('--json');
if (json) writeFileSync(json, `${JSON.stringify({ samples, node: process.version, rows }, null, 2)}\n`);
