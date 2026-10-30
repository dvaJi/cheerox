import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as reference from 'cheerio';
import * as rusteerio from '../dist/modern.mjs';

test('the production parser preserves document mode and fragment context', () => {
  for (const library of [rusteerio, reference]) {
    const $ = library.load('<table></table><textarea></textarea><svg></svg>');
    const parse = $.root()._parse.bind($.root());
    const document = parse(Buffer.from('<p>complete</p>'), $._options, true, null);
    assert.equal(document.children[0].name, 'html');
    assert.equal(document.children[0].children[0].name, 'head');
    assert.equal(document.children[0].children[1].children[0].name, 'p');
    const row = parse('<tr><td>cell</td></tr>', $._options, false, $('table')[0]);
    assert.equal(row.children[0].name, 'tbody');
    assert.equal(row.children[0].children[0].children[0].name, 'td');
    const raw = parse('<b>literal</b>', $._options, false, $('textarea')[0]);
    assert.equal(raw.children[0].data, '<b>literal</b>');
    const svg = parse('<circle/>', $._options, false, $('svg')[0]);
    assert.equal(svg.children[0].namespace, 'http://www.w3.org/2000/svg');
  }
});

test('the production parser keeps existing roots and moves supplied nodes', () => {
  for (const library of [rusteerio, reference]) {
    const $ = library.load('<main><p>one</p><p>two</p></main>');
    const original = $._root;
    const selection = $('p');
    assert.equal(selection._parse(original, $._options, true, null), original);
    const nodes = selection.toArray();
    const parsed = selection._parse(nodes, $._options, false, null);
    assert.equal(parsed.children[0], nodes[0]);
    assert.equal(parsed.children[1], nodes[1]);
    assert.equal(nodes[0].parent, parsed);
    assert.equal(nodes[1].prev, nodes[0]);
    assert.equal($('main').children().length, 0);
  }
});

test('the production parser selects the Rust HTML/XML tokenizer for XML', () => {
  const read = (library) => {
    const $ = library.load('', { xml: true });
    const root = $.root()._parse('<Root><Item Id="X"/><![CDATA[A<B]]></Root>', $._options, true, null);
    return { name: root.children[0].name, item: root.children[0].children[0].name, attrs: { ...root.children[0].children[0].attribs }, cdata: root.children[0].children[1].children[0].data };
  };
  assert.deepEqual(read(rusteerio), read(reference));
});
