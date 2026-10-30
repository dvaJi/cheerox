import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as cheerio from 'cheerio';
import { load } from '../dist/index.mjs';

const documents = [
  '<main id="m" class="a b"><div class="card\tc1" id="d1"><p class="x">1</p><P CLASS="X" ID="UP">2</P></div><img src="a.png" ALT="t" data-x></main>',
  '<svg viewBox="0 0 1 1"><foreignObject><div class="in">x</div></foreignObject><clipPath id="c"/></svg><p class=" lead  intro\n">t</p><p class="leadintro">u</p>',
  '<ul><li class="a-b">1</li><li class="a_b">2</li><li class="-x">3</li><li class="a">4<b class="a">5</b></li></ul><input type=text disabled><script id="s">x</script><style class="st">y</style>',
];
const selectors = [
  'div', 'DIV', 'p', 'P', '*', 'li', 'b', 'svg', 'foreignObject', 'foreignobject', 'clipPath', 'script', 'style',
  '.a', '.b', '.x', '.X', '.card', '.c1', '.lead', '.intro', '.leadintro', '.a-b', '.a_b', '.-x', '.in', '.st',
  '#m', '#d1', '#UP', '#up', '#c', '#s', 'p.x', 'P.X', 'div.card.c1', 'li.a', 'main#m.a.b', '#m.a', '*.a',
  '[src]', '[alt]', '[ALT]', '[data-x]', '[disabled]', '[class]', '[id]', 'img[src][alt]', 'p[class]',
  'div, p', 'li , b', '.a,.x', '#d1,#UP , img', 'b.a, li.a-b',
];

for (const options of [undefined, { xml: true }, { xml: { xmlMode: false } }, { xml: { lowerCaseTags: true, lowerCaseAttributeNames: true } }]) {
  test(`simple selector matching agrees with the native engine (${JSON.stringify(options) ?? 'default'})`, () => {
    for (const html of documents) {
      const $ = load(html, options);
      const all = $('*');
      for (const selector of selectors) {
        const expected = all.op('matches', { ids: all.ids, selector, options: all.options });
        assert.deepEqual(all.filter(selector).ids, expected, `${selector} in ${html.slice(0, 40)}`);
        // Cheerio forwards lowerCaseTags from find() but not from filter(), so only compare where it is consistent.
        if (typeof options?.xml === 'object' && options.xml.lowerCaseTags) continue;
        const reference = cheerio.load(html, options);
        assert.equal(all.filter(selector).length, reference('*').filter(selector).length, `cheerio count for ${selector}`);
      }
    }
  });
}

test('selectors outside the simple subset still match natively', () => {
  const $ = load('<div><p class="a">x</p><p>y</p></div>');
  for (const selector of ['div > p', 'p:first-child', 'p[class=a]', 'p:not(.a)', 'div p', '.a ~ p']) {
    assert.equal($('p').filter(selector).length, cheerio.load('<div><p class="a">x</p><p>y</p></div>')('p').filter(selector).length, selector);
  }
  assert.throws(() => $('p').filter('p,'));
});

test('simple selectors from the root of a small document agree with Cheerio', () => {
  const pages = [...documents, '<header><template><p class="x">in</p></template><p class="x">out</p></header>'];
  for (const options of [undefined, { xml: true }, { xml: { xmlMode: false } }]) {
    for (const html of pages) {
      const $ = load(html, options);
      const reference = cheerio.load(html, options);
      const describe = (selection) => selection.toArray().map((node) => `${node.name}#${node.attribs.id ?? ''}.${node.attribs.class ?? ''}`).join(' ');
      for (const selector of selectors) assert.equal(describe($(selector)), describe(reference(selector)), `${selector} in ${html.slice(0, 40)} (${JSON.stringify(options)})`);
    }
  }
});

test('descendant chains stay fast on deeply nested documents', () => {
  const $ = load(`<main><section>${'<div>'.repeat(300)}<p>x</p>${'</div>'.repeat(300)}</section></main>`);
  const start = performance.now();
  assert.equal($('main').find('section div div div p').length, 1);
  assert.equal($('main').find('aside div div div p').length, 0);
  assert.equal($('aside div div div p:not(.x)').length, 0);
  assert.equal($('main:has(aside div div div p)').length, 0);
  assert.ok(performance.now() - start < 2000);
});

test('attribute values compare case-insensitively for every attribute css-select treats so', () => {
  const html = '<table><tr><td nowrap="nowrap" scope="col" valign="top" bgcolor="red"><input type="checkbox" checked="checked"><font face="arial" color="red">f</font></td></tr></table>';
  const selectors = ['[nowrap=NOWRAP]', '[scope=COL]', '[valign=TOP]', '[bgcolor=RED]', '[checked=CHECKED]', '[face=ARIAL]', '[color=RED]', '[face=ARIAL s]', 'td[nowrap="NoWrap"] font[color=Red]'];
  const read = (loadDocument) => { const $ = loadDocument(html); return selectors.map((selector) => $(selector).length); };
  assert.deepEqual(read(load), read(cheerio.load));
});
