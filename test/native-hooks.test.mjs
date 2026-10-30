import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Tokenizer } from 'htmlparser2';
import { adapter } from 'parse5-htmlparser2-tree-adapter';
import { Element as ForeignElement, Text as ForeignText } from 'domhandler';
import * as reference from 'cheerio';
import * as rusteerio from '../dist/index.mjs';

function tokenizerFactory(trace, replaceText = false) {
  return class CustomTokenizer extends Tokenizer {
    constructor(options, callbacks) {
      const forwarding = Object.fromEntries(['onattribdata', 'onattribentity', 'onattribend', 'onattribname', 'oncdata', 'onclosetag', 'oncomment', 'ondeclaration', 'onend', 'onopentagend', 'onopentagname', 'onprocessinginstruction', 'onselfclosingtag', 'ontext', 'ontextentity'].map((name) => [name, (...args) => {
        trace.push([name, ...args]);
        if (replaceText && name === 'ontext') callbacks.ontextentity(0x2603, args[1]);
        else callbacks[name](...args);
      }]));
      super(options, forwarding);
    }
  };
}

for (const xml of [true, { xmlMode: false, recognizeCDATA: true, recognizeSelfClosing: true }]) {
  test(`custom Tokenizer events construct the actual native DOM (${JSON.stringify(xml)})`, () => {
    const html = '<Root A="&amp;">hello&#65;<![CDATA[X<Y]]><!--comment--><Item/><?go now?></Root>';
    const run = (library) => {
      const trace = [];
      const Tokenizer = tokenizerFactory(trace, true);
      const $ = library.load(html, { xml: typeof xml === 'object' ? { ...xml, Tokenizer } : { xmlMode: true, Tokenizer } });
      const initial = $.html();
      $('Root, root').append('<Tail>new</Tail>');
      $('Item, item').html('<Inside>data</Inside>');
      return { initial, html: $.html(), trace };
    };
    assert.deepEqual(run(rusteerio), run(reference));
  });
}

test('custom Tokenizer exceptions propagate and HTML5 parsing ignores Tokenizer', async () => {
  const failure = new Error('custom tokenizer failed');
  class BrokenTokenizer { constructor() { throw failure; } }
  for (const library of [rusteerio, reference]) {
    assert.throws(() => library.load('<p>X</p>', { xml: { Tokenizer: BrokenTokenizer } }), (error) => error === failure);
    assert.equal(library.load('<p>X</p>', { Tokenizer: BrokenTokenizer })('p').text(), 'X');
  }
  await assert.rejects(rusteerio.loadAsync('<p>X</p>', { xml: { Tokenizer: BrokenTokenizer } }), (error) => error === failure);
});

test('custom Tokenizer entity callbacks validate Unicode code points during write', () => {
  for (const codePoint of [-1, 0x110000, 1.5, NaN, 1n]) {
    const observed = [];
    for (const library of [rusteerio, reference]) {
      class InvalidTokenizer {
        constructor(_options, callbacks) { this.callbacks = callbacks; this.running = true; }
        write() { this.callbacks.ontextentity(codePoint, 1); }
        end() {}
      }
      try { library.load('x', { xml: { Tokenizer: InvalidTokenizer } }); observed.push(null); }
      catch (error) { observed.push({ name: error.name, message: error.message }); }
    }
    assert.deepEqual(observed[0], observed[1]);
    assert.ok(observed[0]);
  }
});

function customAdapter(created, changes = false) {
  return {
    ...adapter,
    createElement(name, namespace, attributes) {
      const node = adapter.createElement(changes && name === 'article' ? 'section' : name, namespace, attributes);
      created.push(node);
      return node;
    },
    insertText(parent, text) { adapter.insertText(parent, changes ? text.replaceAll('original', 'changed') : text); },
  };
}

for (const isDocument of [true, false]) {
  test(`treeAdapter controls live Rust tree construction (${isDocument ? 'document' : 'fragment'})`, () => {
    const html = '<!doctype html><article id="a">original<table><b>misnested</b><tr><td>X</td></tr></table></article><template><p>T</p></template>';
    const run = (library) => {
      const created = [];
      const $ = library.load(html, { treeAdapter: customAdapter(created, true) }, isDocument);
      const initial = $.html();
      const selected = $('section')[0];
      assert.ok(created.includes(selected));
      assert.ok(selected instanceof ForeignElement);
      $('section').append('<article>original</article>');
      return { initial, final: $.html(), name: selected.name, classes: selected.constructor.name };
    };
    assert.deepEqual(run(rusteerio), run(reference));
  });
}

test('treeAdapter gets actual parent decisions and its errors propagate', () => {
  for (const library of [rusteerio, reference]) {
    const failure = new Error('adapter failed');
    assert.throws(() => library.load('<p>X</p>', { treeAdapter: { ...adapter, createElement() { throw failure; } } }), (error) => error === failure);
    const parents = [];
    const $ = library.load('<table>text<div>foster</div></table>', { treeAdapter: { ...adapter, getParentNode(node) { parents.push(node); return adapter.getParentNode(node); } } });
    assert.ok(parents.length > 0);
    assert.equal($('body').text(), 'textfoster');
  }
});

test('onParseError reports parse5-compatible codes and UTF-16 locations', () => {
  for (const html of ['<p>X', '<!doctype html><p a="1" a="2">X</p>', '<!doctype html><div>\u0000</div>', '<!doctype html><!--unterminated', '<!doctype html><p>&#0; &#x110000;</p>']) {
    const read = (library) => {
      const errors = [];
      library.load(html, { onParseError(error) { errors.push(error); } });
      return errors;
    };
    assert.deepEqual(read(rusteerio), read(reference), JSON.stringify(html));
  }
});

test('onParseError propagates callback exceptions without losing identity', () => {
  for (const library of [rusteerio, reference]) {
    const failure = new Error('parse error callback failed');
    assert.throws(() => library.load('<p>X', { onParseError() { throw failure; } }), (error) => error === failure);
  }
});

test('default DOM views have native-backed prototypes and supplied prototypes survive', () => {
  const $ = rusteerio.load('<p>X<!--C--></p>');
  assert.ok($('p')[0] instanceof rusteerio.dom.Element);
  assert.ok($('p')[0] instanceof rusteerio.dom.NodeWithChildren);
  assert.ok($('p')[0] instanceof rusteerio.dom.Node);
  assert.ok($('p').contents()[0] instanceof rusteerio.dom.Text);
  assert.ok($('p').contents()[1] instanceof rusteerio.dom.Comment);
  assert.ok($._root instanceof rusteerio.dom.Document);
  assert.equal($('p')[0].constructor.name, 'Element');
  const node = new rusteerio.dom.Element('section', { id: 'native' }, [new rusteerio.dom.Text('created')]);
  $('p').append(node);
  assert.equal($('section')[0], node);
  assert.equal($('section').text(), 'created');
  const foreign = new ForeignElement('aside', {}, [new ForeignText('foreign')]);
  $('p').append(foreign);
  assert.equal($('aside')[0], foreign);
  assert.ok(foreign instanceof ForeignElement);
  assert.ok(foreign instanceof rusteerio.dom.Element);
  assert.equal(foreign.children[0].parent, foreign);
});

test('onParseError can change a live treeAdapter before subsequent element creation', () => {
  const read = (library) => {
    let hadError = false;
    const events = [];
    const $ = library.load('<article>text</article>', {
      onParseError(error) { events.push(['error', error.code]); hadError = true; },
      treeAdapter: {
        ...adapter,
        createElement(name, namespace, attributes) {
          events.push(['create', name, hadError]);
          return adapter.createElement(hadError && name === 'article' ? 'section' : name, namespace, attributes);
        },
      },
    });
    return { html: $.html(), articleCreatedAfterError: events.find((event) => event[1] === 'article')?.[2], error: events.find((event) => event[0] === 'error') };
  };
  assert.deepEqual(read(rusteerio), read(reference));
});

for (const xmlMode of [true, false]) {
  test(`custom Tokenizer preserves UTF-16 node indices and node kinds (${xmlMode})`, () => {
    const html = '<r>é💩&amp;<!--x💩--><![CDATA[z💩]]><script>v</script><i A="é">tail</i></r>';
    const read = (library) => {
      const trace = [];
      const $ = library.load(html, { xml: { xmlMode, recognizeCDATA: true, withStartIndices: true, withEndIndices: true, Tokenizer: tokenizerFactory(trace) } });
      const shape = (node) => ({ type: node.type, name: node.name, data: node.data, startIndex: node.startIndex, endIndex: node.endIndex, children: node.children?.map(shape) });
      return shape($._root);
    };
    assert.deepEqual(read(rusteerio), read(reference));
  });
}

for (const html of ['<p>X</p>', '<p>X', '<div><p>X</div>', '<b><i>X</b>Y</i>', '<table><tbody><tr><td>A</table>', '<div><span>X</span></div>']) {
  test(`treeAdapter stack observers receive actual parser stack changes: ${html}`, () => {
    const read = (library) => {
      const events = [];
      const $ = library.load(html, { treeAdapter: {
        ...adapter,
        onItemPush(node) { events.push(['push', node.name]); },
        onItemPop(node, current) { events.push(['pop', node.name, current?.name]); },
      } });
      return { events, html: $.html() };
    };
    assert.deepEqual(read(rusteerio), read(reference));
  });
}

test('cached native records invalidate across selection, direct-node and adoption mutations', () => {
  const $ = rusteerio.load('<main><p id="first">one</p><p>two</p></main>');
  const first = $('p')[0];
  const child = first.children[0];
  assert.equal(first.attribs.id, 'first');
  $('p').first().attr('id', 'second').text('updated');
  assert.equal(first.attribs.id, 'second');
  assert.equal(first.children[0].data, 'updated');
  assert.equal(child.parent, null);
  first.attribs.id = 'direct';
  assert.equal($('p').first().attr('id'), 'direct');
  const target = rusteerio.load('<aside></aside>');
  target('aside').append(first);
  assert.equal(first.parent.name, 'aside');
  assert.equal($('p').length, 1);
  target('p').attr('id', 'moved');
  assert.equal(first.attribs.id, 'moved');
});

test('borrowed DOM cloneNode uses its receiver and child array descriptors stay current', () => {
  for (const library of [rusteerio, reference]) {
    const $ = library.load('<p>A<b>B</b></p><section>C</section>');
    const first = $('p')[0];
    const second = $('section')[0];
    const clone = first.cloneNode.call(second, true);
    assert.equal(clone.name, 'section');
    assert.equal(clone.children[0].data, 'C');
    assert.equal(clone.parent, null);
    assert.equal(Object.getOwnPropertyDescriptor(first.children, 'length').value, 2);
  }
});

function writeChunk(stream, chunk) { return new Promise((resolve, reject) => stream.write(chunk, (error) => error ? reject(error) : resolve())); }

for (const customTokenizer of [false, true]) {
  test(`streamed user ${customTokenizer ? 'Tokenizer' : 'treeAdapter'} hooks run during each write`, async () => {
    const run = async (library) => {
      const trace = [];
      const created = [];
      const options = customTokenizer ? { xml: { Tokenizer: tokenizerFactory(trace, true) } } : { treeAdapter: customAdapter(created, true) };
      let complete;
      const done = new Promise((resolve, reject) => { complete = (error, $) => error ? reject(error) : resolve($); });
      const stream = library.stringStream(options, complete);
      await writeChunk(stream, '<article>original');
      if (customTokenizer) assert.ok(trace.some(([event]) => event === 'onopentagname'));
      else assert.ok(created.some((node) => node.name === 'section'));
      await writeChunk(stream, '</article>');
      stream.end();
      const $ = await done;
      return { html: $.html(), emittedText: customTokenizer ? trace.filter(([event]) => event === 'ontext').length : undefined };
    };
    assert.deepEqual(await run(rusteerio), await run(reference));
  });
}

test('streamed treeAdapter and onParseError exceptions preserve original error identities', async () => {
  for (const hook of ['treeAdapter', 'onParseError']) {
    const failure = new Error(`stream ${hook} failed`);
    const options = hook === 'treeAdapter' ? { treeAdapter: { ...adapter, createElement() { throw failure; } } } : { onParseError() { throw failure; } };
    let callback;
    const done = new Promise((resolve) => { callback = (error) => resolve(error); });
    const stream = rusteerio.stringStream(options, callback);
    stream.on('error', () => {});
    stream.end('<p>X</p>');
    assert.equal(await done, failure);
  }
});

test('streamed parse errors are delivered before their write completes', async () => {
  const errors = [];
  let complete;
  const done = new Promise((resolve, reject) => { complete = (error, $) => error ? reject(error) : resolve($); });
  const stream = rusteerio.stringStream({ onParseError(error) { errors.push(error.code); } }, complete);
  await writeChunk(stream, '<p>X</p>');
  assert.deepEqual(errors, ['missing-doctype']);
  stream.end();
  assert.equal((await done)('p').text(), 'X');
});

test('treeAdapter source location setters and stack observers see actual token positions live', () => {
  const read = (library) => {
    const events = [];
    const $ = library.load('<!doctype html><article a="v">é💩</article>', { sourceCodeLocationInfo: true, treeAdapter: {
      ...adapter,
      appendChild(parent, node) {
        if (node.name === 'article') events.push(['append', node.sourceCodeLocation?.startOffset, node.sourceCodeLocation?.endOffset]);
        adapter.appendChild(parent, node);
      },
      onItemPop(node) { if (node.name === 'article') events.push(['pop', node.sourceCodeLocation?.endTag?.endOffset]); },
      setNodeSourceCodeLocation(node, location) {
        adapter.setNodeSourceCodeLocation(node, location);
        if (node.name === 'article') node.attribs['data-start'] = String(location.startOffset);
      },
    } });
    return { html: $.html(), events, location: $('article')[0].sourceCodeLocation, text: $('article')[0].children[0].sourceCodeLocation };
  };
  assert.deepEqual(read(rusteerio), read(reference));
});

test('HTML and XML attribute dictionaries retain their upstream prototype behavior', () => {
  for (const options of [undefined, { xml: true }]) {
    const read = (library) => {
      const attrs = library.load('<p id="x"/>', options)('p')[0].attribs;
      return { prototype: Object.getPrototypeOf(attrs) === null ? null : 'Object', hasConstructor: 'constructor' in attrs, constructor: attrs.constructor?.name, keys: Object.keys(attrs) };
    };
    assert.deepEqual(read(rusteerio), read(reference));
  }
});

test('loading existing DOM nodes does not invoke parser-only hooks', () => {
  for (const library of [rusteerio, reference]) {
    const node = new ForeignElement('p', {}, [new ForeignText('existing')]);
    class NoParse { constructor() { throw new Error('DOM input should not be tokenized'); } }
    const $ = library.load(node, { xml: { Tokenizer: NoParse } });
    assert.equal($('p')[0], node);
    assert.equal($('p').text(), 'existing');
  }
});

test('native DOM nodes expose the same HTML/XML metadata fields as Cheerio', () => {
  const fields = ['type', 'name', 'data', 'attribs', 'children', 'parent', 'prev', 'next', 'startIndex', 'endIndex', 'namespace', 'x-attribsNamespace', 'x-attribsPrefix', 'x-mode', 'x-name', 'x-publicId', 'x-systemId'];
  const scalar = (value) => value === null || typeof value !== 'object' ? value : typeof value.type === 'string' ? `node:${value.type}` : Array.isArray(value) ? value.length : JSON.stringify({ ...value });
  for (const xml of [false, true]) {
    const input = xml ? '<?x y?><r><![CDATA[A]]><!--B-->T</r>' : '<!doctype html><p><!--C-->T</p>';
    const read = (library) => {
      const $ = library.load(input, xml ? { xml: true } : {});
      const shape = (node) => ({ fields: Object.fromEntries(fields.filter((field) => field in node && node[field] !== undefined).map((field) => [field, scalar(node[field])])), children: node.children?.map(shape) });
      return shape($._root);
    };
    assert.deepEqual(read(rusteerio), read(reference));
  }
});

test('treeAdapter text keeps private-use characters intact', () => {
  const literals = ['<p>&a\ue625</p>', '<p><\ue625</p>', '<p>\r\ue625</p>', '<p>&amp\ue625</p>', '<p>&notin\ue625</p>', '<table>x\ue625<tr><td>y</td></tr></table>'];
  for (const html of ['<i>&#xe625;</i>', '<i>&#xe800;</i>', '<i>&#xe000;x&#xe7ff;</i>', '<title>&#xe625;</title><p title="&#xe625;">&#xe625;</p>', ...literals]) {
    const expected = reference.load(html, { treeAdapter: adapter });
    const actual = rusteerio.load(html, { treeAdapter: adapter });
    assert.equal(actual.html(), expected.html(), html);
    assert.equal(actual('i, p').text(), expected('i, p').text(), html);
  }
});
