import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as reference from 'cheerio';
import * as rusteerio from '../dist/index.mjs';

const input = '<article data-id="1"><h2>One</h2><a href="/one">link</a></article><article data-id="2"><h2>Two</h2><a href="/two">link</a></article>';

test('compiled extraction prefixes preserve callback mutations, context and field order', () => {
  const run = (library) => {
    const $ = library.load(input);
    const trace = [];
    const nested = {
      before: 'h2', href: { selector: 'a', value: 'href' },
      change: { selector: 'h2', value(node, key, data) {
        trace.push([key, Object.keys(data), { ...data }]);
        $(node).text(`updated-${node.parent.attribs['data-id']}`);
        nested.after = { selector: 'h2', value: 'outerHTML' };
        return node.parent.attribs['data-id'];
      } },
      after: 'h2',
    };
    const result = $.extract({ rows: [{ selector: 'article', value: nested }] });
    return { result, trace, html: $.html() };
  };
  assert.deepEqual(run(rusteerio), run(reference));
});

test('extraction never speculatively invokes descriptor getters or Proxy traps', () => {
  const run = (library) => {
    const trace = [];
    const map = {
      first: 'h2',
      get second() { trace.push('second'); return { selector: 'a', get value() { trace.push('value'); return 'href'; } }; },
      third: { selector: 'article', value(node, key, data) { trace.push([key, Object.keys(data)]); return node.attribs['data-id']; } },
    };
    const observed = new Proxy(map, { get(target, key, receiver) { trace.push(`get:${String(key)}`); return Reflect.get(target, key, receiver); }, ownKeys(target) { trace.push('keys'); return Reflect.ownKeys(target); } });
    return { result: library.load(input).extract(observed), trace };
  };
  assert.deepEqual(run(rusteerio), run(reference));
});

test('nested extraction honors custom _make, selector, prop and extract methods', () => {
  const run = (library) => {
    const $ = library.load(input);
    const prop = $.fn.prop;
    $.fn.prop = function (name) { return name === 'textContent' ? 'custom:' + prop.call(this, name) : prop.apply(this, arguments); };
    return $.extract({ rows: [{ selector: 'article', value: { title: 'h2', link: { selector: 'a', value: 'href' } } }] });
  };
  assert.deepEqual(run(rusteerio), run(reference));
});

test('async callback extraction keeps callback results as values and yields during long loops', async () => {
  const html = '<article><h2>One</h2></article>'.repeat(600);
  let ticks = 0;
  let callbacks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const promise = Promise.resolve('kept');
    const result = await rusteerio.extractAll([html], { rows: [{ selector: 'article h2', value(node, key, data) {
      const until = performance.now() + 0.03;
      while (performance.now() < until) { /* Intentional callback work. */ }
      callbacks++;
      assert.equal(node.name, 'h2');
      assert.equal(key, 'rows');
      assert.deepEqual(Object.keys(data), []);
      return promise;
    } }] });
    assert.equal(callbacks, 600);
    assert.ok(ticks > 1, `timer ticks ${ticks}`);
    assert.equal(result[0].rows.length, 600);
    assert.ok(result[0].rows.every((value) => value === promise));
  } finally { clearInterval(timer); }
});

test('extraction preserves special-key assignments, prototypes and key enumeration order', async () => {
  const makeMap = () => JSON.parse('{"before":"h2","__proto__":{"selector":"article","value":{"inherited":"h2"}},"after":"a"}');
  const describe = (value) => ({ ownKeys: Object.keys(value), values: { ...value }, inherited: value.inherited, prototypeKeys: Object.keys(Object.getPrototypeOf(value)) });
  const expected = describe(reference.load(input).extract(makeMap()));
  assert.deepEqual(describe(rusteerio.load(input).extract(makeMap())), expected);
  assert.deepEqual(describe((await rusteerio.extractAll([input], makeMap()))[0]), expected);
  const map = Object.assign(Object.create({ inherited: 'a' }), { 10: 'h2', 2: 'a', title: 'h2', constructor: 'a', toString: 'h2' });
  const oracle = reference.load(input).extract(map);
  assert.deepEqual(rusteerio.load(input).extract(map), oracle);
  assert.deepEqual((await rusteerio.extractAll([input], map))[0], oracle);
  assert.deepEqual(Object.keys(oracle), ['2', '10', 'title', 'constructor', 'toString', 'inherited']);
});

test('callback-supplied result prototypes retain their setters for subsequent fields', async () => {
  const run = async (library, asynchronous) => {
    const trace = [];
    const map = JSON.parse('{"__proto__":null,"after":"h2"}');
    map.__proto__ = { selector: 'article', value() { return { inherited: 'kept', set after(value) { trace.push(value); } }; } };
    const result = asynchronous ? (await library.extractAll([input], map))[0] : library.load(input).extract(map);
    return { keys: Object.keys(result), inherited: result.inherited, trace };
  };
  const expected = await run(reference, false);
  assert.deepEqual(await run(rusteerio, false), expected);
  assert.deepEqual(await run(rusteerio, true), expected);
});

test('async extraction does not assimilate callback function values under the then key', async () => {
  let calls = 0;
  const then = () => { calls++; throw new Error('ordinary extracted function was called'); };
  const map = { then: { selector: 'h2', value: () => then }, nested: [{ selector: 'article', value: { then: { selector: 'h2', value: () => then } } }] };
  const expected = reference.load(input).extract(map);
  const actual = (await rusteerio.extractAll([input], map))[0];
  assert.deepEqual(actual, expected);
  assert.equal(actual.then, then);
  assert.equal(actual.nested[0].then, then);
  assert.equal(calls, 0);
});

for (const useMapProxy of [false, true]) {
  test(`extraction preserves nested descriptor Proxy trap order (${useMapProxy ? 'map' : 'descriptor'})`, async () => {
    const run = async (library, asynchronous) => {
      const trace = [];
      const descriptor = new Proxy({ selector: 'h2', value: 'textContent' }, {
        get(target, key, receiver) { trace.push(`descriptor:${String(key)}`); return Reflect.get(target, key, receiver); },
        getOwnPropertyDescriptor(target, key) { trace.push(`descriptor-own:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
      });
      const values = { first: descriptor, last: 'a' };
      const map = useMapProxy ? new Proxy(values, { get(target, key, receiver) { trace.push(`map:${String(key)}`); return Reflect.get(target, key, receiver); }, ownKeys(target) { trace.push('map-keys'); return Reflect.ownKeys(target); } }) : values;
      const result = asynchronous ? (await library.extractAll([input], map))[0] : library.load(input).extract(map);
      return { result, trace };
    };
    const expected = await run(reference, false);
    assert.deepEqual(await run(rusteerio, false), expected);
    assert.deepEqual(await run(rusteerio, true), expected);
  });
}


test('extraction honors inherited setters and readonly result keys without changing global test state', () => {
  const moduleUrl = new URL('../dist/index.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import * as reference from 'cheerio';
    import * as native from ${JSON.stringify(moduleUrl)};
    Object.defineProperty(Object.prototype,'captured',{configurable:true,set(value){this.seen=value;}});
    Object.defineProperty(Object.prototype,'blocked',{configurable:true,writable:false,value:'locked'});
    const map={captured:'h2',title:'h2'};
    const expected=reference.load('<h2>X</h2>').extract(map);
    assert.deepEqual(native.load('<h2>X</h2>').extract(map),expected);
    assert.deepEqual((await native.extractAll(['<h2>X</h2>'],map))[0],expected);
    assert.deepEqual(Object.keys(expected),['seen','title']);
    assert.throws(()=>reference.load('<h2>X</h2>').extract({blocked:'h2'}),TypeError);
    assert.throws(()=>native.load('<h2>X</h2>').extract({blocked:'h2'}),TypeError);
    await assert.rejects(native.extractAll(['<h2>X</h2>'],{blocked:'h2'}),TypeError);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('nested maps mixing native fields and callbacks extract like Cheerio', async () => {
  const html = '<main>' + Array.from({ length: 30 }, (_, index) => `<article data-id="${index}"><h2>Title ${index}</h2><a href="/${index}">link</a>${index % 4 ? '<p class="x">p</p>' : ''}</article>`).join('') + '</main>';
  const map = () => ({
    rows: [{ selector: 'article', value: {
      before: { selector: 'h2', value: (element, key, row) => `${key}:${Object.keys(row).join(',')}:${element.parent.attribs['data-id']}` },
      title: 'h2',
      link: { selector: 'a', value: 'href' },
      middle: { selector: 'a', value: (element, key, row) => `${row.title}|${row.link}` },
      missing: 'p.x',
      every: ['h2, a'],
      after: { selector: 'h2', value: (element, key, row) => Object.keys(row).length },
    } }],
    first: { selector: 'article', value: { title: 'h2', id: { selector: 'h2', value: (element) => element.parent.attribs['data-id'] } } },
  });
  const expected = reference.load(html).extract(map());
  assert.deepEqual(rusteerio.load(html).extract(map()), expected);
  assert.deepEqual((await rusteerio.extractAll([html, html], map()))[1], expected);
});

test('batch extraction with callbacks matches Cheerio when callbacks change documents between plans', async () => {
  const html = (variant) => '<main><title>T' + variant + '</title>' + Array.from({ length: 12 }, (_, index) => `<article data-id="${variant}-${index}"><h2>Title ${index}</h2><a href="/${index}">link</a></article>`).join('') + '</main>';
  const pages = [0, 1, 2, 3].map(html);
  const map = () => ({
    title: 'title',
    first: { selector: 'article', value: { name: 'h2', id: { selector: 'h2', value: (element) => element.parent.attribs['data-id'] } } },
    renamed: { selector: 'article', value: (element) => { element.attribs['data-id'] = 'changed'; element.children[0].children[0].data = 'Renamed'; return element.attribs['data-id']; } },
    rows: [{ selector: 'article', value: { name: 'h2', link: { selector: 'a', value: 'href' }, id: { selector: 'h2', value: (element) => element.parent.attribs['data-id'] } } }],
    links: [{ selector: 'a', value: 'href' }],
  });
  const expected = pages.map((page) => reference.load(page).extract(map()));
  for (const threads of [1, 3]) assert.deepEqual(await rusteerio.extractAll(pages, map(), { threads }), expected);
  const xmlPages = pages.map((page) => page.replace('<main>', '<feed>').replace('</main>', '</feed>'));
  const xmlMap = () => ({ title: 'title', rows: [{ selector: 'article', value: { name: 'h2', id: { selector: 'h2', value: (element) => element.parent.attribs['data-id'] } } }] });
  assert.deepEqual(await rusteerio.extractAll(xmlPages, xmlMap(), { xml: true, threads: 2 }), xmlPages.map((page) => reference.load(page, { xml: true }).extract(xmlMap())));
  const located = await rusteerio.extractAll(pages, map(), { sourceCodeLocationInfo: true, threads: 2 });
  assert.deepEqual(located, pages.map((page) => reference.load(page, { sourceCodeLocationInfo: true }).extract(map())));
});

test('batch extraction with callbacks reads a document changed before its first snapshot as Cheerio does', async () => {
  const page = '<main><title>Before</title>' + Array.from({ length: 2000 }, (_, index) => `<article data-id="${index}"><h2>Title ${index}</h2><a href="/${index}">link</a></article>`).join('') + '</main>';
  const map = () => ({
    renamed: { selector: 'title', value: (element) => { element.children[0].data = 'After'; return 'renamed'; } },
    rows: [{ selector: 'article', value: { name: 'h2', id: { selector: 'h2', value: (element) => element.parent.attribs['data-id'] } } }],
    title: { selector: 'title', value: (element) => element.children[0].data },
  });
  const expected = reference.load(page).extract(map());
  assert.deepEqual(await rusteerio.extractAll([page, page], map(), { threads: 2 }), [expected, expected]);
});
