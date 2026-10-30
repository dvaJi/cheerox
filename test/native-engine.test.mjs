import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as reference from 'cheerio';
import * as rusteerio from '../dist/modern.mjs';

const input = '<main><ul><li class="a" data-x="First">one</li><li class="b">two <b>B</b></li><li class="a">three</li><li>four</li></ul><p id="escaped:id">end</p></main>';
const selectors = ['li:first', 'li:last', 'li:eq(1)', 'li:eq(-1)', 'li:lt(2)', 'li:gt(1)', 'li:even', 'li:odd', 'li:not(:first)', 'li:not(.a)', 'li:is(.a,.b)', 'ul:has(b)', 'li:contains(two)', 'li:icontains(THREE)', 'li:nth-child(2n+1)', 'li:nth-last-child(2)', 'li:first-child', 'li:last-child', 'li:only-child', 'li.a + li', 'li.b ~ li', '[data-x="first" i]', '#escaped\\:id'];

for (const selector of selectors) {
  test(`native selector ${selector} remains correct after mutation`, () => {
    const expected = reference.load(input);
    const actual = rusteerio.load(input);
    assert.deepEqual(actual(selector).map((_, node) => actual(node).text()).get(), expected(selector).map((_, node) => expected(node).text()).get());
    actual('li').last().before('<li class="a">inserted</li>');
    expected('li').last().before('<li class="a">inserted</li>');
    assert.deepEqual(actual(selector).map((_, node) => actual(node).text()).get(), expected(selector).map((_, node) => expected(node).text()).get());
  });
}

test('custom pseudo functions and aliases operate over Rust-owned nodes', () => {
  const options = { pseudos: { special: (element) => element.name === 'li', withclass: (element, value) => element.name === 'li' && element.attribs.class === value, alias: 'li.a' } };
  const actual = rusteerio.load(input, options);
  const expected = reference.load(input, options);
  for (const selector of [':special', ':withclass(a)', ':alias', 'li:not(:withclass(b))']) {
    assert.equal(actual(selector).text(), expected(selector).text(), selector);
  }
});

test('custom pseudo callback argument validation matches Cheerio', () => {
  for (const [callback, selector] of [
    [(element) => element.name === 'li', ':custom(argument)'],
    [(element) => element.name === 'li', ':custom()'],
    [(element, argument) => element.name === argument, ':custom'],
    [(element, argument) => element.name === argument, ':custom()'],
    [(element, argument) => element.name === argument, ':custom(li)'],
    [(element, argument) => element.name === argument, ':CUSTOM(li)'],
    [(element, argument) => element.name === argument, ':custom(a(b))'],
    [(element) => element.name === 'li', '[data-test=":custom(argument)"]'],
  ]) {
    const read = (library) => {
      try { return { html: library.load(input, { pseudos: { custom: callback } })(selector).toString() }; }
      catch (error) { return { error: error.message }; }
    };
    assert.deepEqual(read(rusteerio), read(reference), selector);
  }
  for (const library of [rusteerio, reference]) {
    const received = [];
    const $ = library.load(input, { pseudos: { custom: function (element) { received.push([arguments.length, arguments[1]]); return element.name === 'li'; } } });
    $(':custom');
    assert.ok(received.length > 0);
    assert.ok(received.every(([count, argument]) => count === 2 && argument === null));
  }
});

test('XML can load and mutate on native workers without an external parser', async () => {
  const xml = '<Root>' + '<Item Id="x"><![CDATA[A < B]]></Item>'.repeat(3000) + '</Root>';
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const documents = await rusteerio.loadAll(Array(8).fill(xml), { xml: true, threads: 2 });
    assert.equal(documents[0]('Item').length, 3000);
    documents[0]('Item').first().attr('Id', 'updated').append('<Child/>');
    assert.equal(documents[0]('Item').first().attr('Id'), 'updated');
    assert.equal(documents[0]('Item > Child').length, 1);
    assert.ok(ticks > 0);
  } finally { clearInterval(timer); }
});

const forms = '<form><fieldset disabled><legend><input id="legend"></legend><input id="inside"></fieldset><input id="text"><input id="empty" type=""><input id="radio" type="radio" checked><input id="checked-text" checked><div id="type-div" type="radio" required></div><button id="button">B</button><select><option id="first">A</option><option id="second">B</option></select><select multiple><option id="third">C</option></select><textarea id="ta" readonly></textarea><p id="blank"></p><p id="parent">text</p></form>';
for (const selector of [':checked', ':selected', ':disabled', ':enabled', ':input', ':button', ':text', ':submit', ':radio', ':required', ':optional', ':empty', ':parent', '[missing!=""]', '[missing!=x]']) {
  test(`native form selector ${selector} follows Cheerio semantics`, () => {
    const read = (api) => { const $ = api.load(forms); return $(selector).map((_, node) => node.attribs.id ?? node.name).get(); };
    assert.deepEqual(read(rusteerio), read(reference));
  });
}

test('XML form aliases preserve case-sensitive attribute values', () => {
  const xml = '<Root><input type="Button"/><input type="button"/><input type="Radio"/><input type="radio"/></Root>';
  for (const selector of [':button', ':radio', ':input']) {
    const read = (api) => { const $ = api.load(xml, { xml: true }); return $(selector).map((_, node) => node.attribs.type).get(); };
    assert.deepEqual(read(rusteerio), read(reference), selector);
  }
});

test('foreign HTML tag selectors retain Cheerio case semantics after mutations', () => {
  for (const mutated of [false, true]) {
    const read = (api, selector) => {
      const $ = api.load('<svg><linearGradient id="gradient"/><circle id="circle"/></svg>');
      if (mutated) $('svg').attr('title', 'changed');
      return $(selector).map((_, node) => node.attribs.id).get();
    };
    for (const selector of ['linearGradient', 'lineargradient', 'svg > *', 'circle']) {
      assert.deepEqual(read(rusteerio, selector), read(reference, selector), `${selector}, mutated=${mutated}`);
    }
  }
});
