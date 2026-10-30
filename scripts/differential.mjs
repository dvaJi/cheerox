/**
 * Differential compatibility harness: runs identical operations against
 * cheerox's legacy facade and the real cheerio@0.22.0 package and compares
 * the results semantically.
 *
 * The oracle (`cheerio-legacy-reference`, an npm alias for cheerio@0.22.0)
 * is a dev dependency and is never imported by the library itself.
 *
 * Run: npm run test:differential
 * Report: test/differential/report.json + console summary
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const legacy = require(join(here, '..', 'dist', 'index.cjs'));
const oracle = require('cheerio-legacy-reference');

/** Cases that mutate: each receives a fresh `$` built from the same HTML. */
const fixtures = {
  fruits: '<ul id="fruits"><li class="apple">Apple</li><li class="orange">Orange</li><li class="pear">Pear</li></ul>',
  mixed: '<div class="a b"><p title="t">One &amp; two <span>three</span></p><!-- c --><input type="checkbox" checked><img src="x.png"><script>if (1 < 2) { x(); }</script></div>',
  malformed: '<p>one<li>two<div>three<b>bold<i>ital</p>four</div>',
  doctype: '<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body><p>&copy; caf&eacute;</p></body></html>',
  entities: '<p a="&quot;q&quot;">&amp; &lt; &gt; &apos; ümläut</p>',
  nesting: '<table><tr><td>cell</td></tr></table><ul><li>a<li>b</ul>',
  forms: '<form><input name="a" value="1"><input name="b" type="checkbox" value="2" checked><select name="c" multiple><option value="x" selected>X</option><option value="y">Y</option></select><textarea name="d">text</textarea></form>',
  xml: '<Root MixedCase="1"><Child>data</Child><Empty/><![CDATA[raw]]>tail</Root>',
  whitespace: '<body><b>foo</b>  <b>bar</b>\n  <i>baz</i></body>',
};

const realWorld = [
  '<!DOCTYPE html><html lang=en><meta charset=utf-8><title>Home</title><nav><ul><li><a href="/">Home</a><li><a href=/about>About</ul></nav><main><h1 class="hero">Welcome</h1><p>Some <b>bold</b> and <i>italic &amp; more</i> text.</p><img src=cat.jpg alt="a cat"><form action=/search><input name=q placeholder="Search&hellip;"><button type=submit>Go</button></form></main><footer>&copy; 2026</footer>',
  '<div id=app><ul class="list items"><li class="item active" data-id=1>First <span class=badge>new</span></li><li class=item data-id=2>Second</li></ul><script>window.x = 1 < 2 && "y";</script><style>.item { color: red; }</style></div>',
  '<p>Unclosed <b>bold <i>italic</p><p>next paragraph <em>emphasis</p><table><tr><td>a<td>b<tr><td>c<td>d</table><!-- comment --><div class=empty></div><br><hr><input disabled type=text value="a &quot;quote&quot;">',
];

function selectionSnapshot($) {
  return $.toArray().map((node) => ({
    type: node.type,
    name: node.name,
    attribs: node.attribs ? { ...node.attribs } : undefined,
    data: node.type === 'text' || node.type === 'comment' || node.type === 'directive' ? node.data : undefined,
  }));
}

/** Each case: { name, html, run($, cheerio) } — the return value is compared. */
const cases = [];
function addCase(name, html, run) {
  cases.push({ name, html, run });
}

// Selection
for (const selector of ['li', '.apple', '#fruits', 'ul li', 'li:first-child', 'li:last-child', 'li:eq(1)', 'li:contains("Pear")', '[class]', 'li.apple,li.pear', '#fruits > li', 'input:checked', 'li:not(.orange)']) {
  addCase(`select ${selector}`, fixtures.fruits + fixtures.mixed, ($0) => selectionSnapshot($0(selector)));
}
addCase('select with context (string)', fixtures.fruits, ($0, c) => selectionSnapshot($0('li', 'ul')));
addCase('select with context (html)', fixtures.fruits, ($0, c) => selectionSnapshot($0('li', '<ul><li class="x">x</li></ul>')));
addCase('select with root (string)', fixtures.fruits, ($0, c) => selectionSnapshot($0('li', null, '<ul><li class="y">y</li></ul>')));
addCase('bare construction', fixtures.fruits, ($0, c) => { const el = c('<div class="z">z</div>'); return { length: el.length, html: c.html(el) }; });

// Traversal
addCase('parents', fixtures.fruits, ($0) => selectionSnapshot($0('.apple').parents()));
addCase('siblings', fixtures.fruits, ($0) => selectionSnapshot($0('.orange').siblings()));
addCase('children selector', fixtures.mixed, ($0) => selectionSnapshot($0('div').children('p,input')));
addCase('find deep', fixtures.mixed, ($0) => selectionSnapshot($0('div').find('span')));
addCase('closest', fixtures.fruits, ($0) => selectionSnapshot($0('.apple').closest('ul')));
addCase('nextUntil filtered', fixtures.fruits, ($0) => selectionSnapshot($0('.apple').nextUntil('.pear', '.orange')));
addCase('filter/not/is', fixtures.fruits, ($0) => ({ f: selectionSnapshot($0('li').filter('.pear')), n: selectionSnapshot($0('li').not('.pear')), is: $0('.apple').is('li') }));
addCase('has', fixtures.mixed, ($0) => selectionSnapshot($0('div').has('span')));

// Attributes & data
addCase('attr get/set/map', fixtures.mixed, ($0) => {
  const before = $0('p').attr('title');
  $0('p').attr('title', 'changed');
  $0('input').attr({ 'data-x': '1', 'data-y': '2' });
  return { before, after: $0('p').attr('title'), map: $0('input').attr(), bool: $0('input').attr('checked') };
});
addCase('data read/write', fixtures.mixed, ($0) => {
  $0('div').data('role', 'container');
  return { all: $0('div').data(), single: $0('div').data('role'), attrs: { ...$0('input').attr() } };
});
addCase('prop tagName/checked', fixtures.mixed, ($0) => ({ tag: $0('input').prop('tagName'), checked: $0('input').prop('checked'), type: $0('input').prop('type') }));
addCase('classes', fixtures.fruits, ($0) => {
  $0('.apple').addClass('fresh ripe');
  $0('.orange').removeClass('orange');
  $0('.pear').toggleClass('rotten');
  return {
    apple: $0('.apple').attr('class'),
    orange: $0('.orange').attr('class'),
    pear: $0('.pear').attr('class'),
    has: $0('.apple').hasClass('fresh'),
  };
});

// Manipulation
addCase('append/prepend html', fixtures.fruits, ($0) => { $0('#fruits').append('<li class="end">End</li>').prepend('<li class="start">Start</li>'); return $0.html(); });
addCase('append existing', fixtures.fruits, ($0) => { $0('#fruits').append($0('.apple')); return $0.html(); });
addCase('wrap', fixtures.fruits, ($0) => { $0('.apple').wrap('<div class="wrapper">'); return $0.html(); });
addCase('replaceWith', fixtures.fruits, ($0) => { $0('.orange').replaceWith('<li class="kiwi">Kiwi</li>'); return $0.html(); });
addCase('remove/empty', fixtures.fruits, ($0) => { $0('.pear').remove(); $0('.orange').empty(); return $0.html(); });
addCase('before/after', fixtures.fruits, ($0) => { $0('.apple').before('<li class="pre">P</li>').after('<li class="post">Q</li>'); return $0.html(); });
addCase('html getter/setter', fixtures.mixed, ($0) => { const before = $0('div').html(); $0('p').html('<em>replaced</em>'); return { before, after: $0('div').html() }; });
addCase('text setter', fixtures.mixed, ($0) => { $0('p').text('plain <b>text</b>'); return $0.html(); });

// Serialization
addCase('html static', fixtures.entities, ($0) => $0.html());
addCase('xml static', fixtures.xml, ($0, c) => c.xml($0.root()));
addCase('toString', fixtures.mixed, ($0) => $0('p').toString());
addCase('outer html with options', fixtures.doctype, ($0) => ({ default: $0.html(), body: $0('body').html(), decoded: $0('p').html(), node: $0.html($0('p')) }));

// Statics
addCase('parseHTML', fixtures.mixed, ($0, c) => (c.parseHTML('<p>a</p><script>b</script>') || []).map((n) => n.type + ':' + (n.name || '')).join(',')); 
addCase('parseHTML keepScripts', fixtures.mixed, ($0, c) => (c.parseHTML('<p>a</p><script>b</script>', true) || []).map((n) => n.type + ':' + (n.name || '')).join(','));
addCase('contains/root/version', fixtures.fruits, ($0, c) => {
  const root = $0.root()[0];
  const li = $0('.apple')[0];
  const ul = $0('ul')[0];
  return { contains: c.contains(ul, li), notContains: c.contains(li, ul), selfContains: c.contains(li, li), rootType: root.type, rootChildren: root.childNodes.length, version: /^0\.\d+\.\d+$/.test(c.version) };
});

// Forms
addCase('serialize forms', fixtures.forms, ($0) => ({ serialize: $0('form').serialize(), array: $0('form').serializeArray() }));
addCase('val', fixtures.forms, ($0) => ({
  input: $0('input[name=a]').val(),
  checkbox: $0('input[name=b]').val(),
  textarea: $0('textarea').val(),
  selectGet: $0('select').val(),
}));

// Real-world pages
for (const [index, page] of realWorld.entries()) {
  addCase(`real-world page ${index + 1} roundtrip`, page, ($0) => $0.html());
  addCase(`real-world page ${index + 1} extraction`, page, ($0) => ({
    links: selectionSnapshot($0('a')),
    headings: $0('h1,h2,h3').map(function () { return $0(this).text(); }).get(),
    scripts: $0('script').length,
    images: $0('img').toArray().map((img) => img.attribs.src),
  }));
  addCase(`real-world page ${index + 1} mutation`, page, ($0) => {
    $0('script,style').remove();
    $0('a').attr('target', '_blank');
    $0('img').wrap('<figure class="media">');
    return $0.html();
  });
}

function semanticEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return a == b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((key, i) => key !== kb[i])) return false;
  return ka.every((key) => semanticEqual(a[key], b[key]));
}

const report = { generated: new Date().toISOString(), oracle: 'cheerio@0.22.0 (cheerio-legacy-reference)', implementation: 'cheerox legacy facade', total: cases.length, passed: 0, failed: 0, differences: [] };

for (const testCase of cases) {
  let actual;
  let expected;
  let actualError;
  let expectedError;
  try { actual = testCase.run(legacy.load(testCase.html), legacy); } catch (error) { actualError = `${error.constructor.name}: ${error.message}`; }
  try { expected = testCase.run(oracle.load(testCase.html), oracle); } catch (error) { expectedError = `${error.constructor.name}: ${error.message}`; }
  const pass = actualError || expectedError ? actualError === expectedError : semanticEqual(actual, expected);
  if (pass) report.passed++;
  else {
    report.failed++;
    report.differences.push({ name: testCase.name, html: testCase.html.slice(0, 120), expected: expectedError ?? expected, actual: actualError ?? actual });
  }
}

const outDirectory = join(here, '..', 'test', 'differential');
mkdirSync(outDirectory, { recursive: true });
writeFileSync(join(outDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Differential harness: ${report.passed}/${report.total} cases match cheerio@0.22.0.`);
if (report.failed) {
  for (const difference of report.differences) console.log(`  DIFF ${difference.name}`);
  process.exitCode = 1;
}
