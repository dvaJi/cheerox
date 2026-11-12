import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { load } from '../dist/modern.mjs';

test('cross-document moves preserve nodes, descendants and held selections', () => {
  const target = load('<div></div>');
  const source = load('<section><p id="p"><b>Before</b></p></section>');
  const selection = source('p');
  const node = selection[0];
  const child = source('b')[0];
  target('div').append(selection);
  assert.equal(source('p').length, 0);
  assert.equal(target('p')[0], node);
  assert.equal(target('b')[0], child);
  assert.equal(selection.text(), 'Before');
  selection.text('After').attr('title', 'moved');
  assert.equal(target('p').text(), 'After');
  assert.equal(target('p').attr('title'), 'moved');
  target('p').attr('id', 'changed');
  assert.equal(selection.attr('id'), 'changed');
  assert.equal(node.parent, target('div')[0]);
  node.children[0].data = 'Direct';
  assert.equal(selection.text(), 'Direct');
});

test('native tree export keeps global links and lossless UTF-16 strings', () => {
  const high = String.fromCharCode(0xd800);
  const first = load(`<p>${high}</p>`);
  const second = load('<section><b>ok</b></section>');
  let previousLastId = -1;
  for (const $ of [first, second]) {
    const records = JSON.parse($.root()[Symbol.for('cheerox.selection.document')].exportTree());
    const byId = new Map(records.map((record) => [record.id, record]));
    assert.ok(records[0].id > previousLastId);
    previousLastId = records.at(-1).id;
    for (const record of records) {
      for (const child of record.children) assert.equal(byId.get(child).parent, record.id);
    }
    const text = records.find((record) => record.type === 'text');
    if ($ === first) assert.equal(text.data, high);
    else assert.equal(text.data, 'ok');
  }
});

test('large root walks keep materialized child arrays live after mutations', () => {
  const $ = load(`<main>${'<article><p>text</p></article>'.repeat(600)}</main>`);
  const root = $.root()[0];
  const html = root.children[0];
  const body = html.children[1];
  const main = body.children[0];
  assert.equal(main.name, 'main');
  assert.equal(main.children.length, 600);
  $(main).prepend('<strong>start</strong>');
  assert.equal(main.children.length, 601);
  assert.equal(main.children[0].name, 'strong');
  $(main.children[1]).remove();
  assert.equal(main.children.length, 600);
  assert.equal(main.children[0].name, 'strong');
});

test('wrapping and mixed-document selections keep identities without moving nodes', () => {
  const first = load('<p id="a">A</p>');
  const second = load('<p id="b">B</p>');
  const a = first('p')[0];
  const b = second('p')[0];
  assert.equal(first(b)[0], b);
  const both = first('p').add(second('p'));
  assert.deepEqual(both.toArray(), [a, b]);
  assert.equal(first('p').length, 1);
  assert.equal(second('p').length, 1);
  assert.equal(both.text(), 'AB');
  assert.equal(both.filter(':first')[0], a);
  assert.equal(both.filter(':last')[0], b);
  assert.deepEqual(second('p').add(first('p')).toArray(), [b, a]);
  assert.equal(both.find('*').length, 0);
  both.attr('title', 'shared').addClass('selected');
  assert.equal(first('p').attr('title'), 'shared');
  assert.equal(second('p').attr('title'), 'shared');
  assert.equal(second('p').hasClass('selected'), true);
});

test('invalid selectors still reject on empty selections', () => {
  const selection = load('')('.missing');
  for (const method of ['find', 'filter', 'not', 'is']) assert.throws(() => selection[method]('['), method);
});

test('mixed-document positional filters skip non-elements and preserve input order', () => {
  const a = load('<main>before<i>A</i>after</main>');
  const b = load('<main><!--comment--><b>B</b></main>');
  const nodes = [a('main').contents()[0], b('b')[0], a('i')[0], b('main').contents()[0]];
  const selection = a(nodes);
  assert.strictEqual(selection.filter(':first')[0], nodes[1]);
  assert.strictEqual(selection.filter(':last')[0], nodes[2]);
  assert.deepEqual(selection.not(':first').toArray(), [nodes[0], nodes[2], nodes[3]]);
});

test('cross-document insertion clones for earlier targets and moves the final original', () => {
  const first = load('<main></main>');
  const second = load('<aside></aside>');
  const source = load('<p><b>Original</b></p>');
  const selected = source('p');
  const node = selected[0];
  const child = source('b')[0];
  first('main').add(second('aside')).append(selected);
  assert.equal(source('p').length, 0);
  assert.notEqual(first('p')[0], node);
  assert.equal(second('p')[0], node);
  assert.equal(second('b')[0], child);
  selected.text('Changed');
  assert.equal(first('p').text(), 'Original');
  assert.equal(second('p').text(), 'Changed');
});

test('overlapping cross-document roots move without duplicating descendant identities', () => {
  const source = load('<article><p>Child</p></article>');
  const target = load('<main></main>');
  const parent = source('article')[0];
  const child = source('p')[0];
  target('main').append([parent, child]);
  assert.equal(source('article').length, 0);
  assert.equal(target('article')[0], parent);
  assert.equal(target('p')[0], child);
  assert.equal(target('article').children().length, 0);
  assert.equal(target('main').children().length, 2);
});

test('DOM child properties route handles to the native arena that owns their parent', () => {
  const source = load('<p>Child</p>');
  const target = load('<main></main>');
  const node = source('p')[0];
  target('main').prop('children', [node]);
  assert.equal(source('p').length, 0);
  assert.equal(target('main').children()[0], node);
  assert.equal(target('main')[0].children[0], node);
  assert.equal(node.parent, target('main')[0]);
});

test('moved selections retain their options and opaque JavaScript data', () => {
  const source = load('<a href="page" checked="yes">Link</a>', { xml: true, baseURI: 'https://source.example/' });
  const target = load('<main></main>', { baseURI: 'https://target.example/' });
  const selected = source('a');
  const callback = () => 'callback';
  const cycle = {}; cycle.self = cycle;
  selected.data({ callback, cycle });
  const data = selected.data();
  target('main').append(selected);
  assert.equal(selected.attr('checked'), 'yes');
  assert.equal(target('a').attr('checked'), 'checked');
  assert.equal(selected.prop('href'), 'https://source.example/page');
  assert.equal(target('a').prop('href'), 'https://target.example/page');
  assert.equal(target('a').data(), data);
  assert.equal(target('a').data('callback'), callback);
  assert.equal(target('a').data('cycle'), cycle);
  target('a').data('value', 'updated');
  assert.equal(selected.data('value'), 'updated');
});

test('data writes preserve primitive values and object toJSON behavior', () => {
  const source = load('<p></p>');
  const target = load('<main></main>');
  const node = source('p');
  const values = [null, true, false, 0, -0, 42, NaN, Infinity, -Infinity, '\ud800'];
  for (const [index, value] of values.entries()) node.data(`v${index}`, value);
  let calls = 0;
  const value = { toJSON() { calls++; return { converted: true }; } };
  node.data('object', value);
  assert.equal(calls, 1);
  target('main').append(node);
  for (const [index, expected] of values.entries()) assert.ok(Object.is(target('p').data(`v${index}`), expected));
  assert.strictEqual(target('p').data('object'), value);
});

test('discarded documents are collectible and moved handles retain their new native owner', (context) => {
  const moduleUrl = new URL('../dist/modern.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { load } from ${JSON.stringify(moduleUrl)};
    const tick = () => new Promise(resolve => setImmediate(resolve));
    async function collect() { for (let i=0;i<5;i++) { await tick(); global.gc(); } await tick(); }
    await collect();
    const before = process.memoryUsage().heapUsed;
    const references = (() => {
      const values = [];
      for (let i=0;i<40;i++) {
        const api = load('<main>' + '<p>Data</p>'.repeat(40) + '</main>');
        api('p').data('value', { index: i });
        values.push(new WeakRef(api('p')._document.raw));
      }
      return values;
    })();
    await collect();
    const survivors = references.filter(reference => reference.deref()).length;
    assert.ok(survivors <= 1, 'discarded native owners retained: ' + survivors);
    let held; let owner;
    (() => {
      const source = load('<p>Held</p>');
      const target = load('<main></main>');
      owner = new WeakRef(target('main')._document.raw);
      held = source('p'); target('main').append(held);
    })();
    await collect();
    assert.ok(owner.deref(), 'a held moved node must keep its current native owner alive');
    held.text('Alive'); assert.equal(held.text(), 'Alive');
    console.log(JSON.stringify({ discardedDocuments: references.length, survivors, heapGrowthBytes: process.memoryUsage().heapUsed-before }));
  `;
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  context.diagnostic(result.stdout.trim());
});
