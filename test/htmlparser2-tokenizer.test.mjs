import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as cheerio from 'cheerio';
import { Tokenizer } from 'htmlparser2-modern';
import * as cheerox from '../dist/modern.mjs';

const modes = {
  xml: { xml: true },
  'xml with lowercase names': { xml: { lowerCaseAttributeNames: true, lowerCaseTags: true, recognizeSelfClosing: true } },
  'htmlparser2 html': { xml: { xmlMode: false } },
  'htmlparser2 html without entity decoding': { xml: { xmlMode: false, decodeEntities: false } },
  'xml with indices': { xml: { withStartIndices: true, withEndIndices: true } },
  'xml without self-closing recognition': { xml: { xmlMode: true, recognizeSelfClosing: false } },
};

function describeTree($) {
  const lines = [];
  const walk = (node, depth) => {
    for (const child of node.children ?? []) {
      lines.push([depth, child.type, child.name, child.data, JSON.stringify(child.attribs), child.startIndex, child.endIndex].join('|'));
      walk(child, depth + 1);
    }
  };
  walk($.root()[0], 0);
  return lines.join('\n');
}

function assertSameParse(input, label) {
  for (const [mode, options] of Object.entries(modes)) {
    const expected = cheerio.load(input, options);
    const actual = cheerox.load(input, options);
    assert.equal(describeTree(actual), describeTree(expected), `${label} tree (${mode})`);
    assert.equal(actual.html(), expected.html(), `${label} html (${mode})`);
  }
}

const fixtures = [
  '<script>for (var i = 0; i < items.length; i++) { run(i); }</script><img src="a.png">',
  '<p>a < b, c <= d, e <> f, g </ h</p>',
  '<div>x<2</x></div>',
  '<span>if (a==b) t="function"==typeof o?o.pop():void 0</span>',
  "<p a=1 b='2' c=\"3\" d e=>text</p>",
  '<a b\'c>d</a><e f="g>h">i</e>',
  '<!---->a<!-->b<!--->c<!-- x -->d',
  '<![CDATA[ x < y ]]><![cdata[ no ]]><!DOCTYPE html><?xml version="1.0"?>',
  '<title>a &amp; b &lt; c</title><textarea>a &amp; b</textarea><xmp><b>raw</b></xmp>',
  '<style>a < b {}</style><script/><b>after</b>',
  '</>text</ 3>more</p></br>',
  '<p 2="b" a="x" 1="a" 10="c" 01="d">order</p>',
  'unterminated <a href="x',
  'closing at end </b\t',
  'closing before an astral character </b 😀',
  '<title><&amp;x</title><title>a</t&lt;b</title><title>a\x1c/title>b',
  '<svg><title>svg<\r</&nbsp',
  '<root><title>t</title><a/><b>x</b></root>',
  '<aǅ ǅb="1">x</aǅ>',
  '&amp &lt; &#60; &#x3c; &notit; &copy <a title="&amp=x &amp;">t</a>',
  '<svg viewBox="0 0 1 1"><foreignObject><p>html</p></foreignObject><path d="M0"/></svg>',
];

for (const [index, input] of fixtures.entries()) {
  test(`htmlparser2 tokenizer fixture ${index}`, () => assertSameParse(input, `fixture ${index}`));
}

test('htmlparser2 tokenizer matches Cheerio on generated markup', () => {
  const pieces = ['<', '>', '/', '=', '"', "'", ' ', '\n', '\t', '!', '?', '-', '--', '[', ']', '&', ';', '#', 'a', 'B', 'x', '1', '0', 'div', 'p', 'br', 'svg', 'title', 'script', 'style', 'textarea', 'xmp', 'CDATA[', ']]>', '<!--', '-->', '&amp;', '&lt', '&#60;', '&notit;', '</', '/>', '<?', '<!', 'é', '😀', ''];
  let seed = 2024;
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  for (let index = 0; index < 1500; index++) {
    const length = 1 + Math.floor(random() * 14);
    let input = '';
    for (let piece = 0; piece < length; piece++) input += pieces[Math.floor(random() * pieces.length)];
    assertSameParse(input, JSON.stringify(input));
  }
});

test('attributes serialize in JavaScript object key order, like Cheerio', () => {
  const input = '<p 2="b" a="x" 1="a" 10="c" 01="d">order</p>';
  for (const options of [undefined, { xml: true }, { xml: { xmlMode: false } }]) {
    assert.equal(cheerox.load(input, options).html(), cheerio.load(input, options).html());
  }
});

test('chunked XML streams parse like a single string', async () => {
  const input = '<root><a title="x &amp; y">1 &lt; 2</a><b>c &amp;d</b><!-- note --><![CDATA[ x < y ]]></root>';
  for (const size of [1, 3, 7]) {
    const document = await new Promise((resolve, reject) => {
      const stream = cheerox.stringStream({ xml: true }, (error, $) => (error ? reject(error) : resolve($)));
      for (let offset = 0; offset < input.length; offset += size) stream.write(input.slice(offset, offset + size));
      stream.end();
    });
    assert.equal(document.html(), cheerio.load(input, { xml: true }).html(), `chunk size ${size}`);
  }
});

test('events replayed from a JavaScript Tokenizer build the same tree as Cheerio', () => {
  for (const input of ['<aǅ ǅb="1">x</aǅ>', '<a>x</a b😀', '😀</1 p##&amp;div', '<p a=1>t</p>']) {
    for (const xmlMode of [true, false]) {
      const expected = cheerio.load(input, { xml: { xmlMode } });
      const actual = cheerox.load(input, { xml: { xmlMode, Tokenizer } });
      assert.equal(describeTree(actual), describeTree(expected), `${JSON.stringify(input)} xmlMode=${xmlMode}`);
    }
  }
});
