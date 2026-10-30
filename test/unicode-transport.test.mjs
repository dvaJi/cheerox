import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { Tokenizer } from 'htmlparser2-modern';
import { adapter } from 'parse5-htmlparser2-tree-adapter';
import * as reference from 'cheerio';
import * as rusteerio from '../dist/modern.mjs';

const fixtures = [
  ['valid scalars', 'café 😀 終'],
  ['lone high surrogate', '\ud800'],
  ['lone low surrogate', '\udfff'],
  ['separated surrogate code units', '\ud800A\udc00'],
  ['mixed paired and unpaired surrogates', '\ud800😀\udfff'],
  ['private-use collision candidates', '\ue000\ue7ff\ue800\uf000\u{f0000}\u{10fffd}'],
  ['surrogates beside private-use scalars', '\ud800\ue000\udfff\ue7ff\ue800\u{f0000}'],
];

function loadResult(library, value, options) {
  const $ = library.load(`<main><p title="${value}" data-value='${JSON.stringify(value)}'>${value}</p><a href="${value}">link</a><!--${value}--></main>`, options);
  return {
    html: $.html(), text: $('p').text(), attribute: $('p').attr('title'), data: $('p').data('value'),
    textContent: $('p').prop('textContent'), nodeText: $('p').contents()[0].data,
    comment: $('main').contents().last()[0].data, href: $('a').prop('href'),
    attributeMatch: $(`p[title="${value}"]`).length,
    contains: $(`p:contains("${value}")`).length,
  };
}

for (const [name, value] of fixtures) {
  for (const xml of [false, true]) {
    test(`UTF-16 input values round-trip through ${xml ? 'XML' : 'HTML'} (${name})`, () => {
      const options = { xml, baseURI: 'https://example.test/base/' };
      assert.deepEqual(loadResult(rusteerio, value, options), loadResult(reference, value, options));
    });
  }

  test(`UTF-16 mutations, callbacks, clone and cross-document moves (${name})`, () => {
    const run = (library) => {
      const source = library.load('<main><p>initial</p></main>');
      source('p').text(value).attr('title', value).data('opaque', value);
      const observed = [];
      source('p').text(function (index, current) {
        observed.push([index, current, this.children[0].data]);
        return `${current} tail`;
      }).attr('title', function (index, current) {
        observed.push([index, current, this.attribs.title]);
        return `${current} attr`;
      });
      const clone = source('p').clone();
      const target = library.load('<section></section>');
      target('section').append(source('p'));
      target('section').append(clone);
      return { source: source.html(), target: target.html(), observed, data: target('p').first().data('opaque') };
    };
    assert.deepEqual(run(rusteerio), run(reference));
  });

  test(`UTF-16 parse-error records preserve code units and order (${name})`, () => {
    const run = (library) => {
      const errors = [];
      const $ = library.load(`<!doctype html>😀\r\n<p title="${value}">${value}</p>`, { onParseError(error) { errors.push(error); } });
      return { errors, html: $.html(), location: $('p')[0].sourceCodeLocation };
    };
    assert.deepEqual(run(rusteerio), run(reference));
  });
}

test('UTF-16 selector substrings can match either half of a valid surrogate pair', () => {
  const run = (library) => {
    const $ = library.load('<p title="😀">😀</p>');
    return ['\ud83d', '\ude00'].map((value) => ({
      contains: $(`p:contains("${value}")`).length,
      prefix: $(`p[title^="${value}"]`).length,
      suffix: $(`p[title$="${value}"]`).length,
      substring: $(`p[title*="${value}"]`).length,
    }));
  };
  assert.deepEqual(run(rusteerio), run(reference));
});

test('private-use text and attributes stay distinct from lone surrogate values', () => {
  const run = (library) => {
    const values = ['\ud800', '\udfff', '\ue000', '\ue7ff', '\ue800', '\u{f0000}'];
    const $ = library.load(`<main>${values.map((value, index) => `<p id="v${index}" title="${value}">${value}</p>`).join('')}</main>`);
    return values.map((value) => ({
      text: $(`p:contains("${value}")`).map((_, node) => $(node).attr('id')).get(),
      attribute: $(`p[title*="${value}"]`).map((_, node) => $(node).attr('id')).get(),
    }));
  };
  assert.deepEqual(run(rusteerio), run(reference));
});

test('async loading and extraction preserve lone surrogate values', async () => {
  const value = '\ud800😀\udfff\ue000';
  const html = `<p title="${value}">${value}</p>`;
  const loaded = await rusteerio.loadAsync(html);
  assert.deepEqual({ text: loaded('p').text(), title: loaded('p').attr('title'), html: loaded.html() }, loadResultForAsync(reference, html));
  const map = { text: 'p', title: { selector: 'p', value: 'title' }, callback: { selector: 'p', value: (node) => node.attribs.title } };
  const expected = [reference.load(html).extract(map)];
  assert.deepEqual(await rusteerio.extractAll([html], map, { threads: 1 }), expected);
});

function loadResultForAsync(library, html) {
  const $ = library.load(html);
  return { text: $('p').text(), title: $('p').attr('title'), html: $.html() };
}

async function streamResult(library, pieces, options) {
  const errors = [];
  let writable;
  const completion = new Promise((resolve, reject) => {
    writable = library.stringStream({ ...options, onParseError(error) { errors.push(error); } }, (error, document) => error ? reject(error) : resolve(document));
    writable.on('error', reject);
  });
  for (const piece of pieces) await new Promise((resolve, reject) => writable.write(piece, (error) => error ? reject(error) : resolve()));
  writable.end();
  const $ = await completion;
  return { html: $.html(), text: $('p').text(), errors };
}

for (const xml of [false, true]) {
  test(`stream boundaries preserve paired and unpaired UTF-16 code units (${xml ? 'XML' : 'HTML'})`, async () => {
    const pieces = ['<p title="', '\ud83d', '\ude00', '\ud800', '">', '\ud83d', '\ude00', '\udfff', '</p>'];
    assert.deepEqual(await streamResult(rusteerio, pieces, { xml }), await streamResult(reference, pieces, { xml }));
  });
}

test('an unpaired high surrogate at stream EOF remains a code unit', async () => {
  assert.deepEqual(await streamResult(rusteerio, ['<p>', '\ud800']), await streamResult(reference, ['<p>', '\ud800']));
});

test('all 65,536 UTF-16 code units survive native mutation and data access', () => {
  const value = Array.from({ length: 65_536 }, (_, unit) => String.fromCharCode(unit)).join('');
  const run = (library) => {
    const $ = library.load('<p></p>');
    $('p').text(value).attr('title', value).data('value', value);
    return { text: $('p').text(), textContent: $('p').prop('textContent'), nodeData: $('p')[0].children[0].data, attribute: $('p').attr('title'), attributeView: $('p')[0].attribs.title, data: $('p').data('value') };
  };
  assert.deepEqual(run(rusteerio), run(reference));
});

test('UTF-16 attribute names, extraction keys and JSON data strings stay distinct', () => {
  const run = (library) => {
    const $ = library.load('<p></p>');
    $('p').attr({ ['data-\ud800']: '"\\udfff"', ['title\ue800']: '\ud800\ue000' });
    const map = { ['\udfff']: { selector: 'p', value: 'title\ue800' }, ['\ue000']: { selector: 'p', value: (node) => node.attribs['title\ue800'] } };
    return { attributes: $('p').attr(), proxyKeys: Object.keys($('p')[0].attribs), data: $('p').data('\ud800'), extracted: $.extract(map) };
  };
  assert.deepEqual(run(rusteerio), run(reference));
});

test('numeric private-use and invalid scalar entities stay distinct in every parser mode', () => {
  const html = '<p a="&#xe000;&#xe800;&#xd800;">&#xe000;&#xe7ff;&#xe800;&#xd800;&#0;&#x110000;&#128;</p>';
  for (const xml of [false, true, { xmlMode: false }]) {
    const run = (library) => {
      const $ = library.load(html, { xml });
      return { text: $('p').text(), attribute: $('p').attr('a'), html: $.html(), containsSurrogate: $('p:contains("\ud800")').length, containsPrivateUse: $('p:contains("\ue000")').length };
    };
    assert.deepEqual(run(rusteerio), run(reference));
  }
});

test('HTML entity compatibility keeps legacy text and attribute contexts separate', () => {
  const html = '<p a="&copycat &copy= &copy &#x41 &#128;">&copycat &copy= &copy &#x41 &#128;</p>';
  const run = (library) => {
    const $ = library.load(html, { xml: { xmlMode: false } });
    return { text: $('p').text(), attribute: $('p').attr('a'), html: $.html() };
  };
  assert.deepEqual(run(rusteerio), run(reference));
});

test('CSS escapes preserve UTF-16 units, private-use literals, null and Unicode case folding', () => {
  const selectors = [String.raw`p[title*="\d83d\de00"]`, String.raw`p[title*="\d83d "]`, String.raw`p[title*="\e000 "]`, String.raw`p[title*="\0 "]`, 'p[title="CAFÉ" i]'];
  const run = (library) => {
    const $ = library.load('<p id="emoji"></p><p id="surrogate"></p><p id="private"></p><p id="null"></p><p id="case"></p>');
    const values = ['😀', '\ud83d', '\ue000', '\0', 'café'];
    $('p').each((index, node) => $(node).attr('title', values[index]));
    return selectors.map((selector) => $(selector).map((_, node) => $(node).attr('id')).get());
  };
  assert.deepEqual(run(rusteerio), run(reference));
});

test('custom Tokenizer source indices and decoded private-use entities preserve UTF-16', () => {
  const run = (library) => {
    const trace = [];
    class InspectTokenizer extends Tokenizer {
      constructor(options, callbacks) {
        super(options, Object.fromEntries(['onattribdata', 'onattribentity', 'onattribend', 'onattribname', 'oncdata', 'onclosetag', 'oncomment', 'ondeclaration', 'onend', 'onopentagend', 'onopentagname', 'onprocessinginstruction', 'onselfclosingtag', 'ontext', 'ontextentity'].map((name) => [name, (...args) => { trace.push([name, ...args]); callbacks[name](...args); }])));
      }
    }
    const $ = library.load('<p a="&#xe000;\ud800">\ud800&#xe000;&amp;</p><!--\ue000\udfff-->', { xml: { xmlMode: true, Tokenizer: InspectTokenizer, withStartIndices: true, withEndIndices: true } });
    return { trace, html: $.html(), text: $('p').text(), attribute: $('p').attr('a'), span: [$('p')[0].startIndex, $('p')[0].endIndex] };
  };
  assert.deepEqual(run(rusteerio), run(reference));
});

test('live treeAdapter callbacks receive and return lossless UTF-16 values', () => {
  const run = (library) => {
    const observed = [];
    const treeAdapter = {
      ...adapter,
      createElement(name, namespace, attributes) {
        if (name === 'p') {
          observed.push(attributes.map((attribute) => ({ ...attribute })));
          attributes = attributes.map((attribute) => ({ ...attribute, value: `${attribute.value}\udfff\ue000` }));
        }
        return adapter.createElement(name, namespace, attributes);
      },
      insertText(parent, value) {
        observed.push(value);
        adapter.insertText(parent, `${value}\udfff\ue800`);
      },
    };
    const $ = library.load('<p title="\ud800">\ud800\ue000</p>', { treeAdapter });
    return { observed, html: $.html(), text: $('p').text(), attribute: $('p').attr('title') };
  };
  assert.deepEqual(run(rusteerio), run(reference));
});

test('CJS and ESM share Unicode node identity across document moves', () => {
  const require = createRequire(import.meta.url);
  const cjs = require('../dist/modern.cjs');
  const source = cjs.load('<p></p>');
  source('p').text('\ud800\ue000😀').data('value', '\udfff\ue800');
  const node = source('p')[0];
  const target = rusteerio.load('<main></main>');
  target('main').append(node);
  assert.equal(target('p')[0], node);
  assert.equal(target('p').text(), '\ud800\ue000😀');
  assert.equal(target('p').data('value'), '\udfff\ue800');
  assert.equal(source('p').length, 0);
});

test('form URL encoding preserves Unicode scalars and rejects unpaired UTF-16 units', () => {
  const run = (library, name, value) => {
    const $ = library.load('<form><input></form>');
    $('input').attr({ name, value });
    let serialized;
    try { serialized = { value: $('form').serialize() }; }
    catch (error) { serialized = { error: error.constructor.name, message: error.message }; }
    return { array: $('form').serializeArray(), serialized };
  };
  for (const [name, value] of [['café\ue000', '😀\ue800 space'], ['field', '\ud800'], ['\udfff', 'value'], ['\ud800\ue000', '\udfff😀']]) {
    assert.deepEqual(run(rusteerio, name, value), run(reference, name, value));
  }
});
