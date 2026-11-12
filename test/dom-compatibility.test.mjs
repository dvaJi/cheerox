import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Element, hasChildren, isText } from 'domhandler';
import * as cheerio from 'cheerio';
import * as cheerox from '../dist/modern.mjs';

test('static HTML rendering uses Cheerio option merging for htmlparser2 trees', () => {
  const html = '<div>Ω<br><span title="">text</span></div>';
  for (const options of [{ _useHtmlParser2: true }, { xml: { xmlMode: false } }, { xml: true }, {}]) {
    const actual = cheerox.load(html, options);
    const expected = cheerio.load(html, options);
    for (const override of [undefined, {}, { decodeEntities: false }, { xmlMode: true }, { _useHtmlParser2: true }]) {
      assert.equal(actual.html(override), expected.html(override), JSON.stringify({ options, override }));
    }
    assert.equal(actual('div').html(), expected('div').html());
  }
  const node = new Element('br', {});
  assert.equal(cheerox.load('').html(node), cheerio.load('').html(node));
});

test('closing names preserve XML case, Unicode and unpaired UTF-16', () => {
  const html = '<Root><X>1</x><Ω>2</Ω><\ud800>3</\ud800><n>4</n></Root>';
  for (const options of [{ xml: true }, { xml: { lowerCaseTags: true } }]) {
    assert.equal(cheerox.load(html, options).html(), cheerio.load(html, options).html());
  }
  const ascii = '<DIV><P>one</p><span>two</SPAN></DIV>';
  const options = { xml: { xmlMode: false } };
  assert.equal(cheerox.load(ascii, options).html(), cheerio.load(ascii, options).html());
});

test('XML child lists preserve order and node identity across growth and mutation', () => {
  const actual = cheerox.load('<root><a/><b/></root>', { xml: true });
  const expected = cheerio.load('<root><a/><b/></root>', { xml: true });
  const held = actual('a')[0];
  for (const $ of [actual, expected]) {
    $('root').append('<c/><d/>');
    $('b').replaceWith('<x/><y/>');
    $('d').remove();
    $('root').prepend('<first/>');
    $('c').before('<z/>');
  }
  assert.equal(actual.xml(), expected.xml());
  assert.deepEqual(actual('root').children().toArray().map(node => node.name), ['first', 'a', 'x', 'y', 'z', 'c']);
  assert.strictEqual(actual('a')[0], held);
});

test('large materialized selections preserve live attributes, identity and mutations', () => {
  for (const options of [{}, { xml: true }]) {
    const html = '<main>' + Array.from({ length: 100 }, (_, i) => `<a data-n="${i}">x</a>`).join('') + '</main>';
    const actual = cheerox.load(html, options);
    const nodes = actual('a').toArray();
    const attrs = nodes[50].attribs;
    assert.strictEqual(nodes[50], actual('a').eq(50)[0]);
    actual(nodes[50]).attr('data-n', 'changed');
    assert.strictEqual(nodes[50].attribs, attrs);
    assert.equal(attrs['data-n'], 'changed');
    actual(nodes[50]).remove();
    assert.equal(actual('a').length, 99);
    assert.equal(nodes[50].attribs['data-n'], 'changed');
  }
});

test('materializing repeated node references preserves identity and live changes', () => {
  const $ = cheerox.load('<main>' + '<a href="/x">x</a>'.repeat(100) + '</main>');
  const original = $('a').first()[0];
  const repeated = $(Array(64).fill(original)).toArray();
  assert.equal(repeated.length, 64);
  assert.ok(repeated.every(node => node === original));
  $(original).attr('href', '/changed');
  assert.ok(repeated.every(node => node.attribs.href === '/changed'));
  const reversed = $('a').toArray().reverse();
  const selection = $(reversed).toArray();
  assert.deepEqual(selection, reversed);
  assert.strictEqual(selection[selection.length - 1], original);
});

test('domhandler recognizes native parent nodes during a text-node walk', async () => {
  const input = '<main><a href="/about">About <strong>the team</strong></a><!--note--><p>Contact hello@example.test</p><script>hidden</script></main>';
  for (const options of [undefined, { xml: true }, { sourceCodeLocationInfo: true }]) {
    const expected = cheerio.load(input, options);
    const documents = [cheerox.load(input, options), await cheerox.loadAsync(input, options), ...(await cheerox.loadAll([input], options))];
    for (const actual of documents) {
      assert.deepEqual(walkText(actual.root()[0]), walkText(expected.root()[0]));
      assert.deepEqual(walkText(actual('main').clone()[0]), walkText(expected('main').clone()[0]));
      actual('a').append('<span> today</span>');
      assert.deepEqual(walkText(actual('a')[0]), ['About ', 'the team', ' today']);
      for (const node of actual.root().find('*').addBack().toArray()) {
        assert.ok(hasChildren(node), node.name ?? node.type);
        assert.ok(Object.hasOwn(node, 'children'));
        const descriptor = Object.getOwnPropertyDescriptor(node, 'children');
        assert.ok(descriptor.enumerable);
        assert.ok(descriptor.configurable);
      }
      for (const node of actual('a, main').contents().toArray().filter((node) => isText(node) || node.type === 'comment')) {
        assert.equal(hasChildren(node), false);
      }
    }
  }
  const document = cheerox.load('<root><![CDATA[text]]></root>', { xml: true });
  assert.ok(hasChildren(document('root').contents()[0]));
  assert.deepEqual(walkText(document.root()[0]), ['text']);
});

test('htmlparser2 serializes doctypes, foreign content and options like Cheerio', () => {
  const inputs = [
    '<!doctype html><p>text</p>',
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd"><p>text</p>',
    '<!DOCTYPE svg SYSTEM "about:legacy-compat"><svg/>',
    '<svg viewBox="0 0 10 10" style=""><clipPath id="clip"><path d="M0 0"/></clipPath><use xlink:href="#clip"/></svg>',
    '<svg><foreignObject><div title="">HTML<br><input disabled></div><svg viewBox="0 0 1 1"><path/></svg></foreignObject></svg>',
    '<math definitionURL="example"><mi><span title="">é &amp;</span></mi><annotation-xml><svg><path/></svg></annotation-xml></math>',
    '<svg><title>é &lt; &amp;</title><desc><p>description</p></desc><text title="é \' &amp;">é \' &lt; &gt; &amp;</text></svg>',
    '<p title="é \' &lt; &gt; &amp;">é \' &lt; &gt; &amp;</p><br><img src=""><basefont><bgsound>',
    '<noscript><b>fallback</b>&amp;</noscript><iframe><p>frame</p></iframe>',
  ];
  const overrides = [{}, { emptyAttrs: true }, { selfClosingTags: true }, { selfClosingTags: false }, { encodeEntities: 'utf8' }, { decodeEntities: false }, { decodeEntities: false, encodeEntities: true }, { scriptingEnabled: false }];
  for (const input of inputs) for (const override of overrides) {
    const options = { xml: { xmlMode: false, ...override } };
    const expected = cheerio.load(input, options);
    const actual = cheerox.load(input, options);
    assert.equal(actual.html(), expected.html(), `${input} ${JSON.stringify(override)}`);
    for (const selector of ['svg', 'foreignObject', 'math', 'p']) {
      assert.equal(actual(selector).html(), expected(selector).html(), `${selector} inner HTML`);
      assert.equal(actual(selector).prop('outerHTML'), expected(selector).prop('outerHTML'), `${selector} outer HTML`);
    }
    actual('script, style').remove();
    expected('script, style').remove();
    assert.equal(actual.html(), expected.html(), 'after mutation');
  }
});

test('htmlparser2 serialization matches Cheerio on 300 generated documents', () => {
  for (let index = 0; index < 300; index++) {
    const input = `<!doctype html><main data-id="${index}"><iframe><p>Frame ${index}</p></iframe><svg viewBox="0 0 ${index + 1} 10"><linearGradient id="g${index}"/><path fill="url(#g${index})"/><foreignObject><p title="">é &amp; ${index}</p></foreignObject></svg><math definitionURL="urn:${index}"><mi>x</mi></math><img src=""><br></main>`;
    const options = { xml: { xmlMode: false, selfClosingTags: index % 2 === 0, emptyAttrs: index % 3 === 0, encodeEntities: index % 5 === 0 ? 'utf8' : true } };
    const expected = cheerio.load(input, options);
    const actual = cheerox.load(input, options);
    assert.equal(actual.html(), expected.html(), `document ${index}`);
    assert.deepEqual(walkText(actual.root()[0]), walkText(expected.root()[0]), `text nodes ${index}`);
  }
});

function walkText(root) {
  const nodes = [root];
  const result = [];
  while (nodes.length) {
    const node = nodes.pop();
    if (isText(node)) result.push(node.data);
    else if (hasChildren(node)) nodes.push(...node.children.toReversed());
  }
  return result;
}
