import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as cheerio from 'cheerio';
import * as rusteerio from '../dist/index.mjs';

const fixtures = [
  '', 'plain < text &amp; emoji 🚀', '\ufeff<h1>UTF8 😀 café</h1>',
  '<!doctype html><html lang="en"><head><title>T</title></head><body>Hello</body></html>',
  '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><p>x',
  '<!--before--><p title="x &quot; y" data-z="z" data-a="a">&nbsp; &copy; &lt; &gt; &amp;</p><!--after-->',
  '<div z="1" a="2" class="a b" id="ID" title="&nbsp;">&apos; &quot; &#x1F600;</div>',
  '<p>A<p>B<div>C</div>D', '<table>before<tr><td>A<td>B</tr>after</table>',
  '<b><i>A</b>B</i>C', '<select><option>A<option>B</select>',
  '<input checked disabled value="a&amp;b"><br><hr><img src=x>',
  '<textarea>\n&lt;b&gt;&amp;</textarea><pre>\nspaces\n</pre>',
  '<script>if (a < b && c > d) x = "&amp;";</script><style>a > b {content:"&amp;"}</style>',
  '<noscript><b>A</b>&amp;</noscript>',
  '<template><article><h2>Inside</h2><template>nested</template></article></template><p>Outside</p>',
  '<svg viewBox="0 0 1 1"><a xlink:href="#a" xmlns:xlink="http://www.w3.org/1999/xlink"><text>A &amp; B</text></a><foreignObject><p>HTML</p></foreignObject></svg>',
  '<math><mi>x</mi><annotation-xml encoding="text/html"><div>HTML</div></annotation-xml></math>',
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><use xlink:href="#a"/></svg>',
  '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi xml:lang="en">x</mi></math><div xmlns="http://www.w3.org/1999/xhtml" xmlns:custom="urn:x">HTML</div>',
  '<template><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg></template>',
  '<div title="a\u00a0b\nc\td">a\u00a0b\rc</div>',
  '<x-custom data-test="test">Custom</x-custom>',
  '<iframe><b>raw</b>&amp;</iframe><xmp>a<b>&amp;</xmp>',
];

for (const [index, input] of fixtures.entries()) {
  for (const isDocument of [true, false]) {
    test(`HTML5 fixture ${index} (${isDocument ? 'document' : 'fragment'})`, () => {
      const expected = cheerio.load(input, {}, isDocument);
      const actual = rusteerio.load(input, {}, isDocument);
      assert.equal(actual.html(), expected.html(), 'native serialization');
      assert.equal(actual.text(), expected.text(), 'native text');
      for (const selector of ['*', 'p', 'div', 'h2', 'template', 'script', 'svg a', '[data-test]']) {
        assert.equal(actual(selector).length, expected(selector).length, selector);
        assert.equal(actual(selector).text(), expected(selector).text(), `${selector} text`);
        assert.equal(actual(selector).html(), expected(selector).html(), `${selector} html`);
      }
      // A callback forces DOM materialization; normalization and serialization
      // must remain equivalent after that transition.
      actual('*').each(() => {});
      assert.equal(actual.html(), expected.html(), 'serialization after DOM materialization');
      assert.equal(actual.text(), expected.text(), 'text after DOM materialization');
    });
  }
}

test('foreign xmlns attributes serialize like Cheerio from every serializer', () => {
  const input = '<div><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg><math xmlns="http://www.w3.org/1998/Math/MathML"><mi xml:lang="en">x</mi></math></div>';
  const expected = cheerio.load(input);
  const actual = rusteerio.load(input);
  for (const selector of ['svg', 'math', 'div']) {
    assert.equal(actual(selector).prop('outerHTML'), expected(selector).prop('outerHTML'), `${selector} outerHTML`);
    assert.equal(actual.html(actual(selector)), expected.html(expected(selector)), `${selector} $.html`);
  }
  assert.doesNotMatch(actual.html(), / :xmlns=/);
  actual('svg').attr('data-mutated', '1');
  expected('svg').attr('data-mutated', '1');
  assert.equal(actual('div').html(), expected('div').html(), 'after mutation');
  assert.equal(actual('svg').attr('xmlns'), expected('svg').attr('xmlns'));
});

test('template contents do not traverse into the host document', () => {
  const input = '<html><body><header class="host"><template><section class="top"><p><img class="inner"></p></section></template><img class="outer"></header></body></html>';
  const expected = cheerio.load(input);
  const actual = rusteerio.load(input);
  const names = (selection) => selection.toArray().map((node) => node.name).join(',');
  const compare = (label) => {
    // Traversal always runs on the mutable tree, so one pass covers it.
    for (const selector of ['img.inner', 'section.top', 'img.outer']) {
      assert.equal(names(actual(selector).parents()), names(expected(selector).parents()), `${label} ${selector} parents`);
      assert.equal(actual(selector).closest('header').length, expected(selector).closest('header').length, `${label} ${selector} closest`);
      assert.equal(names(actual(selector).parentsUntil('body')), names(expected(selector).parentsUntil('body')), `${label} ${selector} parentsUntil`);
      assert.equal(actual(selector).parent().length, expected(selector).parent().length, `${label} ${selector} parent`);
      assert.equal(actual(selector).is('header img'), expected(selector).is('header img'), `${label} ${selector} is`);
    }
  };
  compare('traversal');
  const nested = '<template><div><template><span class="deep"></span></template></div></template>';
  assert.equal(rusteerio.load(nested)('span.deep').parents().length, cheerio.load(nested)('span.deep').parents().length, 'nested template');
});

test('htmlparser2 rendering writes stored attribute names like Cheerio', () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="#a">link</a></svg>';
  const options = { xml: { xmlMode: false } };
  assert.equal(rusteerio.load(input).html(options), cheerio.load(input).html(options));
});

test('the adoption agency keeps every node it moves', async () => {
  const inputs = [
    '<small><li><a></a>\n<p></small>',
    '<SMALL><LI><A></A>\n<P></SMALL>',
    '<b><li>x<i>y</i>\n<p>z</b>after',
    '<a href=1><div>one\n<span>two</span>\n<p>three</a>tail',
    '<em><ul><li><a></a> <p>1</p> <p>2</p></em><li>next</ul>',
  ];
  for (const input of inputs) {
    assert.equal(rusteerio.load(input).html(), cheerio.load(input).html(), `document ${JSON.stringify(input)}`);
    assert.equal(rusteerio.load(input, {}, false).html(), cheerio.load(input, {}, false).html(), `fragment ${JSON.stringify(input)}`);
    const actual = rusteerio.load('<div></div>');
    const expected = cheerio.load('<div></div>');
    actual('div').html(input);
    expected('div').html(input);
    assert.equal(actual.html(), expected.html(), `inner html ${JSON.stringify(input)}`);
    const streamed = await new Promise((resolve, reject) => {
      const stream = rusteerio.stringStream({}, (error, $) => error ? reject(error) : resolve($.html()));
      stream.end(input);
    });
    assert.equal(streamed, cheerio.load(input).html(), `stream ${JSON.stringify(input)}`);
  }
});

test('plain text fragments parse like any other fragment', () => {
  const inputs = ['', ' ', 'plain value 31', '  padded\n\ttext  ', 'é漢😀', '', '﻿bom', 'a > b = "c"', '\u0001ctrl', 'a\nb', ' nbsp'];
  for (const input of inputs) for (const options of [undefined, {}, { scriptingEnabled: false }]) {
    const describe = ($) => [$.html(), $.text(), $.root()[0].children.map((node) => [node.type, node.data])];
    assert.deepEqual(describe(rusteerio.load(input, options, false)), describe(cheerio.load(input, options, false)), JSON.stringify(input));
  }
});
