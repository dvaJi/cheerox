import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasChildren, isText } from 'domhandler';
import * as cheerio from 'cheerio';
import * as cheerox from '../dist/modern.mjs';

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
