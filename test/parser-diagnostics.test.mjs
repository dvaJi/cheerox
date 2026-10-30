import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as reference from 'cheerio';
import * as cheerox from '../dist/modern.mjs';

// Compare the public callback records verbatim, including their order and
// UTF-16 positions. Cheerio's bundled parse5 is the compatibility oracle.
const cases = {
  doctypes: [
    '', ' \t\r\n', '<!doctype html>', '<!DOCTYPE HTML>', '<!doctype>', '<!doctype svg>',
    '<!doctype html PUBLIC "legacy">', '<!doctype html SYSTEM "about:legacy-compat">',
    '<!doctype html PUBLIC>', '<!doctype html SYSTEM>', '<!doctype html SYSTEM "x" junk>',
    '<!doctype html><!doctype html>', '<p><!doctype html>', '<!doctype html',
  ],
  attributes: [
    '<p a=1 a=2>', '<p A=1 a=2 b=3 b=4>', '<p a=>', '<p a="x"b="y">',
    '<p a=x`y>', '<p a=x<y>', '<p a=x=y>', '<p =x>', '<p a="x>', "<p a='x>",
    '<p a=x', '<p a="\u0000">', '<p/ a=x>', '</p a=x>', '</p/>', '<p>',
  ],
  comments: [
    '<!-->', '<!--->', '<!-- x --!>', '<!-- <!-- nested -->', '<!-- x', '<!--',
    '<?processing instruction?>', '<!bogus>', '<![CDATA[x]]>', '<!--\u0000-->',
  ],
  entities: [
    '<p>&#0;</p>', '<p>&#x110000;</p>', '<p>&#xD800;</p>', '<p>&#xFDD0;</p>',
    '<p>&#13;&#x80;&#x1F;</p>', '<p>&#;&#x;</p>', '<p>&unknown;</p>',
    '<p>&amp &copy &notit; &#32 &#x41</p>', '<p a="&amp &copy= &notit; &#0;">',
    '<p>&#9999999999999999999999999999999999999999;</p>',
    '<p>\u0000\u0001\u000B\u007F\u0080\uFDD0</p>', '<p>&amp; café 😀 終</p>',
  ],
  textModes: [
    '<!doctype html><script>unterminated', '<!doctype html><script><!--x',
    '<!doctype html><script><!--<script>x</script>', '<!doctype html><style>x',
    '<!doctype html><title>x', '<!doctype html><textarea>x', '<!doctype html><plaintext>x',
    '<!doctype html><svg><![CDATA[x]]></svg>', '<!doctype html><svg><path/></svg>',
    '<!doctype html><div/>',
  ],
  treeRecovery: [
    '<!doctype html><head><head>', '<!doctype html></head></head>', '<!doctype html></body>',
    '<!doctype html><head></head><meta charset=utf-8>', '<!doctype html></template>',
    '<!doctype html><template><div></template>', '<!doctype html><template><table></template>',
    '<!doctype html><table>text<div>foster</div><tr><td>X</table>',
    '<!doctype html><b><i>x</b>y</i>', '<!doctype html><select><table><option>x</select>',
    '<!doctype html><html><body><p>x</html>tail',
  ],
  positions: [
    ' \t\r\n<p a=>', '&#32;&#10;<p a=>', '😀\r\n<p a=1 a=2>',
    '<!--before--> \r\n café<p a=>', '<!doctype html>😀\r\n<p a=>',
    '<!doctype html>終\r\n<p a="😀" a="x">\u0000',
    'X<p a=>', 'X X<p a=>', 'X<!--bad', 'X\u0001<p>', 'X X\u0001<p>', 'X\u0000X', 'X X\u0000X',
    `${' '.repeat(70_000)}&#32;\r\nX`,
  ],
};

function read(library, html, options, isDocument) {
  const errors = [];
  library.load(html, { ...options, onParseError(error) { errors.push(error); } }, isDocument);
  return errors;
}

for (const [group, inputs] of Object.entries(cases)) {
  for (let index = 0; index < inputs.length; index += 1) {
    for (const isDocument of [true, false]) {
      test(`parse diagnostics ${group}/${index} ${isDocument ? 'document' : 'fragment'}`, () => {
        const html = inputs[index];
        assert.deepEqual(read(cheerox, html, {}, isDocument), read(reference, html, {}, isDocument), JSON.stringify(html.slice(0, 256)));
      });
    }
  }
}

for (const html of [
  '<!doctype html><head><noscript><noscript>x</noscript>',
  '<!doctype html><head><noscript><head>',
  '<!doctype html><head><noscript></p>',
  '<!doctype html><head><noscript><div>x',
  '<!doctype html><head><noscript>',
]) {
  test(`parse diagnostics scripting-disabled ${JSON.stringify(html)}`, () => {
    assert.deepEqual(read(cheerox, html, { scriptingEnabled: false }, true), read(reference, html, { scriptingEnabled: false }, true));
  });
}

async function readStream(library, html, chunkSize) {
  const errors = [];
  let writable;
  const finished = new Promise((resolve, reject) => {
    writable = library.stringStream({ onParseError(error) { errors.push(error); } }, (error) => error ? reject(error) : resolve());
    writable.on('error', reject);
  });
  const characters = Array.from(html);
  for (let index = 0; index < characters.length; index += chunkSize) {
    await new Promise((resolve, reject) => writable.write(characters.slice(index, index + chunkSize).join(''), (error) => error ? reject(error) : resolve()));
  }
  writable.end();
  await finished;
  return errors;
}

for (const chunkSize of [1, 7, 16_384]) {
  test(`streamed parse diagnostics preserve complete records at ${chunkSize}-character boundaries`, async () => {
    const html = '<!doctype html>😀\r\n<p a="x" a="y">&#0; &#x110000; &amp x</p><!--unterminated';
    assert.deepEqual(await readStream(cheerox, html, chunkSize), await readStream(reference, html, chunkSize));
  });
}

test('streamed leading whitespace preserves the first non-whitespace location', async () => {
  const html = `${' '.repeat(70_000)}&#32;\r\nX`;
  assert.deepEqual(await readStream(cheerox, html, 16_384), await readStream(reference, html, 16_384));
});
