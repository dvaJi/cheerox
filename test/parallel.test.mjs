import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import * as cheerio from 'cheerio';
import * as cheerox from '../dist/modern.mjs';

const html = '<!doctype html><title>Example</title><main><h2 data-id="1">One &amp; two</h2><h2>Three</h2><a href="/relative">Link</a></main>';

test('the test suite uses the actual Rust addon', () => {
  assert.equal(cheerox.nativeStatus().available, true, cheerox.nativeStatus().error);
});

test('ESM and CommonJS expose the Cheerio entry points', () => {
  const cjs = createRequire(import.meta.url)('../dist/modern.cjs');
  for (const key of Object.keys(cheerio)) {
    assert.equal(typeof cheerox[key], typeof cheerio[key], key);
    assert.equal(typeof cjs[key], typeof cheerio[key], key);
  }
  assert.equal(cjs.load(html)('h2').text(), 'One & twoThree');
});

test('the legacy root entry keeps the callable 0.22.0 surface', () => {
  const requireCjs = createRequire(import.meta.url);
  const cjs = requireCjs('../dist/index.cjs');
  assert.equal(typeof cjs, 'function');
  assert.equal(cjs.version, requireCjs('../package.json').version);
  for (const key of ['load', 'html', 'xml', 'text', 'parseHTML', 'root', 'contains', 'version']) {
    assert.ok(key in cjs, key);
  }
  assert.equal('fn' in cjs, false, 'the bare module has no fn until load() is called');
  const $ = cjs.load(html);
  assert.equal($('h2').text(), 'One & twoThree');
});

test('async loading and parallel loading produce equivalent mutable documents', async () => {
  const $ = await cheerox.loadAsync(html);
  assert.equal($('h2').text(), cheerio.load(html)('h2').text());
  $('h2').first().text('Changed');
  assert.equal($('h2').first().text(), 'Changed');
  const inputs = [html, '<p>B</p>', '', '<!--c--><ul><li>C</ul>'];
  const docs = await cheerox.loadAll(inputs, { threads: 2 });
  assert.deepEqual(docs.map(doc => doc.html()), inputs.map(input => cheerio.load(input).html()));
  docs[0]('h2').remove();
  assert.equal(docs[1]('p').text(), 'B');
});

test('fragment and XML async options match Cheerio', async () => {
  const $ = await cheerox.loadAsync('<td>A</td><td>B</td>', {}, false);
  assert.equal($.html(), cheerio.load('<td>A</td><td>B</td>', {}, false).html());
  const xml = '<Root><Item Id="X"/></Root>';
  const xmls = await cheerox.loadAll([xml, xml], { xml: true, threads: 2 });
  assert.deepEqual(xmls.map(doc => doc.html()), [xml, xml].map(input => cheerio.load(input, { xml: true }).html()));
});

test('parallel extraction matches $.extract for text, attributes, missing values and arrays', async () => {
  const map = {
    title: 'h2',
    titles: ['h2'],
    href: { selector: 'a', value: 'href' },
    ids: [{ selector: 'h2', value: 'data-id' }],
    missing: '.missing',
    empty: ['.missing'],
    absentAttr: { selector: 'a', value: 'id' },
  };
  const inputs = [html, '<p>Empty</p>', html.replace('One', 'Last')];
  for (const threads of [1, 2, 8]) {
    assert.deepEqual(await cheerox.extractAll(inputs, map, { threads }), inputs.map(input => cheerio.load(input).extract(map)));
  }
});

test('parallel extraction supports full Cheerio extract maps', async () => {
  const map = {
    nested: [{ selector: 'main', value: { titles: ['h2'], href: { selector: 'a', value: 'href' } } }],
    callback: { selector: 'h2', value: (node, key) => `${key}:${node.name}` },
    pseudos: ['h2:contains(Three)'],
  };
  assert.deepEqual(await cheerox.extractAll([html], map, { threads: 2 }), [cheerio.load(html).extract(map)]);
});

test('parallel extraction resolves relative URLs with baseURI', async () => {
  const map = { href: { selector: 'a', value: 'href' } };
  const options = { baseURI: 'https://example.com/base/', threads: 2 };
  assert.deepEqual(await cheerox.extractAll([html], map, options), [cheerio.load(html, options).extract(map)]);
});

test('parallel extraction preserves keys that shadow Object.prototype', async () => {
  const map = { constructor: '.missing', toString: '.missing' };
  assert.deepEqual(await cheerox.extractAll([html], map, { threads: 2 }), [cheerio.load(html).extract(map)]);
});

test('parallel APIs preserve empty input and reject invalid configuration', async () => {
  assert.deepEqual(await cheerox.loadAll([], { threads: 2 }), []);
  assert.deepEqual(await cheerox.extractAll([], { titles: ['h2'] }, { threads: 2 }), []);
  for (const threads of [0, -1, 1.5, NaN, Infinity, 100000]) {
    await assert.rejects(async () => cheerox.loadAll([html], { threads }), /thread|integer|range/i);
    await assert.rejects(async () => cheerox.extractAll([html], { title: 'h2' }, { threads }), /thread|integer|range/i);
  }
  await assert.rejects(() => cheerox.extractAll([html], { bad: '[' }, { threads: 2 }));
});

test('native batch extraction leaves the event loop responsive', async () => {
  const large = '<main>' + '<article><h2>Title &amp; text</h2><p>Body</p></article>'.repeat(10000) + '</main>';
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const results = await cheerox.extractAll(Array(12).fill(large), { titles: ['h2'] }, { threads: 2 });
    assert.equal(results.length, 12);
    assert.equal(results[0].titles.length, 10000);
    assert.ok(ticks > 0, 'a main-thread timer must run while native work executes');
  } finally {
    clearInterval(timer);
  }
});

test('retained selections reflect mutation and preserve node identity', () => {
  const $ = cheerox.load(html);
  const before = $('h2');
  const first = before.first();
  assert.equal(first.text(), 'One & two');
  $('h2').first().attr('data-id', 'changed');
  assert.equal(first.attr('data-id'), 'changed');
  assert.equal(before[0], first[0]);
  before.first().remove();
  assert.equal(before.length, 2);
  assert.equal($('h2').length, 1);
});

test('cached read methods observe later mutations', () => {
  const $ = cheerox.load(html);
  const selection = $('h2');
  const text = selection.text;
  selection.first().text('Updated');
  assert.equal(text.call(selection), 'UpdatedThree');
});

test('the loaded factory remains constructable like Cheerio', () => {
  for (const isDocument of [true, false]) {
    const actual = cheerox.load(html, {}, isDocument);
    const expected = cheerio.load(html, {}, isDocument);
    for (const selector of ['h2', 'main', '.missing']) {
      const selection = new actual(selector);
      const reference = new expected(selector);
      assert.equal(selection.text(), reference.text());
      assert.equal(selection.length, reference.length);
      assert.equal(selection instanceof actual, reference instanceof expected);
    }
  }
});

test('foreign element selectors and namespaced attributes match Cheerio', () => {
  const input = '<svg><linearGradient gradientUnits="userSpaceOnUse"></linearGradient><a xlink:href="#target">Link</a></svg>';
  for (const selector of ['linearGradient', 'lineargradient', '\\6c inear\\47 radient', '[gradientUnits]', '[gradientunits]', '[href]']) {
    const actual = cheerox.load(input);
    const expected = cheerio.load(input);
    assert.equal(actual(selector).length, expected(selector).length, selector);
    assert.equal(actual(selector).text(), expected(selector).text(), selector);
  }
  assert.equal(cheerox.load(input)('a').attr('href'), cheerio.load(input)('a').attr('href'));
});

test('materialization preserves the document parsing mode', () => {
  for (const input of ['<p>Quirks', '<!doctype html><p>Standards', '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd"><p>Limited']) {
    const actual = cheerox.load(input);
    const expected = cheerio.load(input);
    assert.equal(actual.root()[0]['x-mode'], expected.root()[0]['x-mode']);
  }
});

test('multiple selectors remain scoped to multiple contexts', () => {
  const input = '<main><h2>A</h2><h3>B</h3></main><aside><h2>C</h2></aside><footer><h3>D</h3></footer>';
  assert.equal(cheerox.load(input)('h2,h3', 'main,aside').text(), cheerio.load(input)('h2,h3', 'main,aside').text());
});

test('plugins can override native fast methods', () => {
  const $ = cheerox.load(html);
  $.fn.text = function () { return 'plugin'; };
  assert.equal($('h2').text(), 'plugin');
  const other = cheerox.load(html);
  assert.equal(other('h2').text(), 'One & twoThree');
});

test('buffer decoding and string/decode streams preserve the public API', async () => {
  assert.equal(cheerox.loadBuffer(Buffer.from(html))('h2').text(), 'One & twoThree');
  for (const name of ['stringStream', 'decodeStream']) {
    const result = new Promise((resolve, reject) => {
      const stream = cheerox[name]({}, (error, $) => error ? reject(error) : resolve($));
      stream.on('error', reject);
      stream.end(name === 'decodeStream' ? Buffer.from(html) : html);
    });
    const $ = await result;
    assert.equal($('h2').text(), 'One & twoThree');
  }
});
