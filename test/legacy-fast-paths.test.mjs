import assert from 'node:assert/strict';
import { test } from 'node:test';
import oracle from 'cheerio-legacy-reference';
import cheerox from '../dist/index.mjs';

test('typed legacy attributes preserve live views and simple tag node kinds', () => {
  const $ = cheerox.load('<main><article id="a" class="card"><a href="/">x</a></article><script>x</script><style>y</style></main>');
  const article = $('article')[0];
  const attributes = article.attribs;

  $('article').attr('data-order', '1').addClass('link');
  assert.strictEqual(article.attribs, attributes);
  assert.equal(attributes['data-order'], '1');
  assert.equal(attributes.class, 'card link');
  assert.equal($('article.link').length, 1);
  assert.equal($('article').find('a')[0].type, 'tag');
  assert.equal($('script')[0].type, 'script');
  assert.equal($('style')[0].type, 'style');

  $('article').attr('data-callback', function (index, previous) {
    assert.strictEqual(this, article);
    assert.equal(index, 0);
    assert.equal(previous, undefined);
    return 'yes';
  });
  assert.strictEqual(article.attribs, attributes);
  assert.equal(attributes['data-callback'], 'yes');

  $('article').attr('__proto__', 'safe');
  assert.equal(Object.getOwnPropertyDescriptor(attributes, '__proto__')?.value, 'safe');
  $('article').removeAttr('__proto__');
  assert.equal(Object.hasOwn(attributes, '__proto__'), false);
});

test('static adjacent insertion preserves multi-root DOM state and fallbacks', () => {
  const input = '<main><section><p class="x">A</p></section><section><p class="x">B</p></section></main>';
  const actual = cheerox.load(input);
  const expected = oracle.load(input);
  for (const $ of [actual, expected]) $('.x').after('<span class="marker">m</span>text<!--c-->');
  assert.equal(actual.html(), expected.html());

  for (const section of actual('section').toArray()) {
    const children = section.children;
    const marker = children.find((node) => node.name === 'span');
    assert.ok(marker);
    assert.strictEqual(marker.parent, section);
    assert.equal(marker.root, null);
    assert.equal(marker.prev.name, 'p');
    assert.equal(marker.next.type, 'text');
    assert.equal(children.at(-1).type, 'comment');
    assert.equal(children.at(-1).root, null);
  }

  const actualFallback = cheerox.load(input);
  const expectedFallback = oracle.load(input);
  const actualChildren = actualFallback('section').first()[0].children;
  const expectedChildren = expectedFallback('section').first()[0].children;
  actualFallback('.x').before('<em>before</em>');
  expectedFallback('.x').before('<em>before</em>');
  assert.strictEqual(actualFallback('section').first()[0].children, actualChildren);
  assert.strictEqual(expectedFallback('section').first()[0].children, expectedChildren);
  assert.equal(actualFallback.html(), expectedFallback.html());
});

test('batched removal matches nested duplicate and filtered oracle mutations', () => {
  const input = '<main><div id="a"><p id="b"><span>x</span></p></div><div id="d"><p class="second">y</p></div></main>';
  const actual = cheerox.load(input);
  const expected = oracle.load(input);
  const actualA = actual('#a')[0];
  const actualB = actual('#b')[0];
  const expectedA = expected('#a')[0];
  const expectedB = expected('#b')[0];
  actual([actualA, actualB, actualB]).remove();
  expected([expectedA, expectedB, expectedB]).remove();
  assert.equal(actual.html(), expected.html());
  assert.equal(actualA.root, null);
  assert.equal(actualB.root, null);

  const actualFiltered = cheerox.load(input);
  const expectedFiltered = oracle.load(input);
  const actualChildren = actualFiltered('#d')[0].children;
  const expectedChildren = expectedFiltered('#d')[0].children;
  actualFiltered('p').remove('.second');
  expectedFiltered('p').remove('.second');
  assert.strictEqual(actualFiltered('#d')[0].children, actualChildren);
  assert.strictEqual(expectedFiltered('#d')[0].children, expectedChildren);
  assert.equal(actualFiltered.html(), expectedFiltered.html());
});
