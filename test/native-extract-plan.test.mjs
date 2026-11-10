import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as reference from 'cheerio';
import * as cheerox from '../dist/modern.mjs';

const html = '<section><a id="one" class="link" href="/path" title="hello" data-id="7" aria-label="Read">A<b>B</b></a><input name="choice" value="x" checked disabled><script>hidden</script><p>visible</p></section><section><p>last</p></section>';

test('native tag name extraction matches HTML, SVG, XML and nested maps', async () => {
  const input = '<main><img src="/x"><svg><linearGradient id="g"/></svg><script>x</script><style>y</style><section><p>text</p></section></main>';
  const map = { names: [{ selector: '*', value: 'name' }], types: [{ selector: '*', value: 'type' }], nodeTypes: [{ selector: '*', value: 'nodeType' }], tags: [{ selector: '*', value: 'tagName' }], sections: [{ selector: 'section', value: { name: { selector: 'p', value: 'nodeName' } } }] };
  for (const options of [{}, { xml: true }, { xml: { xmlMode: false } }]) {
    const expected = reference.load(input, options).extract(map);
    assert.deepEqual((await cheerox.extractAll([input], map, options))[0], expected);
  }
});

test('native extraction plans match all supported scalar properties and missing values', async () => {
  const properties = ['textContent', 'innerText', 'innerHTML', 'outerHTML', 'tagName', 'nodeName', 'nodeType', 'id', 'class', 'className', 'title', 'href', 'src', 'alt', 'name', 'value', 'type', 'checked', 'selected', 'disabled', 'multiple', 'readOnly', 'required', 'hidden', 'open', 'autofocus', 'controls', 'loop', 'muted', 'data-id', 'aria-label'];
  const map = Object.fromEntries(properties.flatMap(value => [[value, [{ selector: 'a,input,script,p', value }]], [`missing_${value}`, { selector: 'absent', value }]]));
  for (const options of [{}, { baseURI: 'https://example.test/base/' }, { xml: true }]) {
    const expected = reference.load(html, options).extract(map);
    const actual = (await cheerox.extractAll([html], map, { ...options, threads: 2 }))[0];
    assert.deepEqual(actual, expected);
    assert.deepEqual(Object.keys(actual), Object.keys(expected));
    assert.ok(Object.hasOwn(actual, 'missing_href'));
  }
});

test('native nested plans preserve ordered keys and independently missing nested fields', async () => {
  const map = {
    before: 'missing',
    sections: [{ selector: 'section', value: { missing: '.absent', labels: ['p'], link: { selector: 'a', value: { missing: 'strong', bold: 'b', absentList: ['i'] } } } }],
    after: 'p',
  };
  const expected = reference.load(html).extract(map);
  const actual = (await cheerox.extractAll([html], map))[0];
  assert.deepEqual(actual, expected);
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  assert.deepEqual(Object.keys(actual.sections[0]), Object.keys(expected.sections[0]));
  assert.ok(Object.hasOwn(actual.sections[1], 'link'));
});
