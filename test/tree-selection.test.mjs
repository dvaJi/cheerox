import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { load } from '../dist/modern.mjs';

const documents = [
  readFileSync(new URL('./upstream/__fixtures__/fixtures.ts', import.meta.url), 'utf8').match(/`[^`]*<[^`]*`/g).map((source) => source.slice(1, -1)).join('\n'),
  '<!doctype html><html><head><title>T</title></head><body><main id="m"><section class="a b"><h2 lang="en-US">One</h2><p class="lead">x <b>y</b></p><p></p><input type="CHECKBOX" checked><select><option>1</option><option selected>2</option></select></section><section class="b"><ul><li>1</li><li class="odd x">2</li><li>3</li></ul><a href="/a" rel="NoFollow">a</a><a href="https://e.test/b">b</a></section><svg viewBox="0 0 1 1"><use href="#x" xlink:href="#y"/><foreignObject><div class="in">f</div></foreignObject></svg><template><p class="t">in template</p></template></main></body></html>',
];
const selectors = [
  'p', 'section > p', 'section p', 'h2 + p', 'h2 ~ p', 'main section:first-child', 'li:nth-child(2)', 'li:nth-child(odd)', 'li:last-child',
  'p:empty', 'p:not(.lead)', 'section:has(ul)', 'li:contains(2)', ':header', ':checked', 'option:selected', 'input[type=checkbox]',
  'a[rel=nofollow]', 'a[href^=https]', 'a[href$=b]', 'a[href*=e.test]', '[lang|=en]', '.a.b', 'section.b > *', '*', ':root', 'p:first', 'li:eq(1)',
  'li:gt(0)', 'p:last', 'li:odd', 'use[href]', 'div.in', 'foreignObject div', 'template p', 'p.t', ':is(h2, li.x)', 'SECTION', 'Li', 'a:not([rel])',
  ':input', ':text', 'section:parent', 'b:only-child', 'p:first-of-type', 'li:nth-last-child(1)', '*:not(script)',
];

for (const [index, html] of documents.entries()) {
  test(`parse-tree selection matches the mutable arena (document ${index})`, () => {
    const tree = load(html);
    const arena = load(html);
    arena.root()._document.raw.op('clone', JSON.stringify({ ids: [0], deep: false }));
    for (const selector of selectors) {
      let expected;
      try { expected = arena(selector).toArray().map((node) => arena(node).toString()); } catch (error) { assert.throws(() => tree(selector), undefined, selector); continue; }
      assert.deepEqual(tree(selector).toArray().map((node) => tree(node).toString()), expected, selector);
      const contexts = arena('section').length ? 'section' : '*';
      assert.equal(tree(contexts).find(selector).length, arena(contexts).find(selector).length, `find ${selector}`);
      assert.equal(tree('*').filter(selector).length, arena('*').filter(selector).length, `filter ${selector}`);
      assert.equal(tree('*').is(selector), arena('*').is(selector), `is ${selector}`);
    }
    assert.equal(tree('li').hasClass('odd'), arena('li').hasClass('odd'));
    assert.deepEqual(tree.extract({ links: [{ selector: 'a', value: 'href' }], items: ['li'] }), arena.extract({ links: [{ selector: 'a', value: 'href' }], items: ['li'] }));
  });
}

test('selection within contexts matches Cheerio before and after the document changes', async () => {
  const cheerio = await import('cheerio');
  const html = documents[1];
  for (const isChanged of [false, true]) {
    const actual = load(html);
    const expected = cheerio.load(html);
    if (isChanged) { actual('body').append('<i></i>'); expected('body').append('<i></i>'); }
    for (const selector of selectors) {
      for (const context of [undefined, 'section', 'main', 'li']) {
        const read = ($) => { try { return (context ? $(context).find(selector) : $(selector)).toArray().map((node) => $(node).toString()); } catch { return 'error'; } };
        assert.deepEqual(read(actual), read(expected), `${context ?? 'document'} → ${selector}${isChanged ? ' (changed)' : ''}`);
      }
    }
  }
});

test('namespaced attributes read the same from snapshots and single reads', async () => {
  const cheerio = await import('cheerio');
  const html = `<svg>${'<use href="#a" xlink:href="#b"/>'.repeat(200)}<a xlink:title="t">x</a></svg>`;
  const read = ($) => $('use, a').toArray().map((node) => [node.name, { ...node.attribs }, { ...node['x-attribsNamespace'] }, { ...node['x-attribsPrefix'] }]);
  assert.deepEqual(read(load(html)), read(cheerio.load(html)));
});

test('every top-level node of a fragment has the root as its parent', async () => {
  const cheerio = await import('cheerio');
  const html = '<meta charset="utf-8"><script>a</script><p>x</p><style>s</style><table><tr><td>c</td></tr></table>';
  const read = ($) => {
    const parents = $.root()[0].children.map((node) => node.parent?.type);
    $('script, style').remove();
    return [parents, $.html()];
  };
  assert.deepEqual(read(load(html, {}, false)), read(cheerio.load(html, {}, false)));
});

test('removing nodes from an unchanged document matches Cheerio for later reads and writes', async () => {
  const cheerio = await import('cheerio');
  const html = '<main><nav><a href="/">Home</a></nav><section><p class="a">one <b>bold</b></p><script>x()</script><p>two</p></section><template><p>t</p></template><ul><li>1</li><li>2</li><li>3</li></ul></main>';
  for (const isDocument of [true, false]) {
    const read = (loadDocument) => {
      const $ = loadDocument(html, {}, isDocument);
      const section = $('section')[0];
      const children = section.children;
      const removed = $('script, nav, li:nth-child(2)').remove();
      const result = [
        children.map((node) => node.name ?? node.type), $.html(), $('main').text(), $('*').length, $('a').length,
        removed.toArray().map((node) => [node.name, node.parent, node.prev, node.next]),
        $('p').add(removed).toArray().map((node) => node.name), $.contains($('main')[0], removed[0]),
        $('ul > li').length, $('li').last().prev().text(), removed.find('a').length,
      ];
      $('ul').append(removed.last());
      $('section').prepend('<i>new</i>');
      result.push($.html(), $('li').toArray().map((node) => node.children[0].data), children.length);
      return result;
    };
    assert.deepEqual(read(load), read(cheerio.load));
  }
});

test('adding text nodes, fragments and nodes of other documents orders them as Cheerio does', async () => {
  const cheerio = await import('cheerio');
  const html = `<main>${Array.from({ length: 40 }, (_, i) => (i % 3 ? `<div id="d${i}">x${i}<span>s${i}</span></div>` : `<p>t${i}<b>b${i}</b>u${i}<!--c${i}--></p>`)).join('')}</main>`;
  const walk = (node) => [node, ...(node.children ?? []).flatMap(walk)];
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 40; round++) {
    const plan = Array.from({ length: 1 + Math.floor(random() * (round % 2 ? 300 : 60)) }, random);
    const read = (library) => {
      const $ = library.load(html, null, round % 4 !== 0);
      const other = library.load('<ul><li>o1</li><li>o2</li></ul>');
      const pool = [...walk($.root()[0]), ...$('<i>f</i>text<b>g</b>').toArray().flatMap(walk), ...walk(other.root()[0])];
      const chosen = plan.map((value) => pool[Math.floor(value * pool.length)]);
      return $(chosen).add([]).toArray().map((node) => pool.indexOf(node));
    };
    assert.deepEqual(read({ load }), read(cheerio), `round ${round}`);
  }
});

test('text and attributes written in HTML mode are escaped even with decodeEntities false', async () => {
  const cheerio = await import('cheerio');
  const read = (loadDocument) => {
    const $ = loadDocument('<p>x</p>', { decodeEntities: false });
    $('p').text('<input> & y').attr('title', 'a & "b"');
    $('p').append('a < b & c');
    return [$.html(), $.html({ decodeEntities: false })];
  };
  assert.deepEqual(read(load), read(cheerio.load));
});

test('XML queries match Cheerio before and after structural writes', async () => {
  const cheerio = await import('cheerio');
  const xml = `<?xml version="1.0"?><feed><Entry id="1"><title>A</title><link href="/a"/><cat><title>nested</title></cat></Entry><entry id="2"><title>B</title><link/></entry><ENTRY><Title>C</Title></ENTRY><![CDATA[<title>not an element</title>]]></feed>`;
  const selectors = ['title', 'Title', 'entry', 'Entry', 'entry title', 'feed > entry > title', 'link[href]', 'entry, Entry, title', 'cat title', 'feed *', 'title:first-child', 'missing'];
  const read = (loadDocument) => {
    const $ = loadDocument(xml, { xml: true });
    const before = selectors.map((selector) => $(selector).toArray().map((node) => $(node).text()));
    $('entry').first().append('<title>appended</title>');
    $('Entry title').first().remove();
    $('<entry><title>new</title></entry>').prependTo('feed');
    const after = selectors.map((selector) => $(selector).toArray().map((node) => $(node).text()));
    return [before, after];
  };
  assert.deepEqual(read(load), read(cheerio.load));
});

test('elements with very long attribute values read the same as Cheerio before and after a snapshot', async () => {
  const cheerio = await import('cheerio');
  const path = 'M0 0'.concat(' L1 1'.repeat(2000));
  const html = `<main>${Array.from({ length: 120 }, (_, i) => `<p class="p${i}">t${i}</p>`).join('')}<svg><path id="long" d="${path}" fill="red"/></svg><img data-props='${JSON.stringify({ items: 'x'.repeat(6000) })}' alt="a" src="/i.png"></main>`;
  const read = (loadDocument) => {
    const $ = loadDocument(html);
    const nodes = [];
    const walk = (node) => { nodes.push(node); for (const child of node.children ?? []) walk(child); };
    walk($.root()[0]);
    return [
      $('#long').attr('d').length, $('path').attr('fill'), $('img').attr('alt'), $('img').data('props').items.length,
      nodes.filter((node) => node.attribs).map((node) => Object.keys(node.attribs).join(',')).join('|'),
      $('[d]').length, $('img[src="/i.png"]').length, $.html().length,
    ];
  };
  assert.deepEqual(read(load), read(cheerio.load));
});

test('traversals read from snapshots match Cheerio, also after attribute writes', async () => {
  const cheerio = await import('cheerio');
  const html = `<main>${Array.from({ length: 40 }, (_, i) => `<section id="s${i}">t${i}<!--c--><h2>h${i}</h2><p>a <b>b</b> c</p><ul><li>1</li><li class="x">2</li></ul></section>`).join('')}</main>`;
  const kinds = ['parent', 'parents', 'children', 'contents', 'siblings', 'next', 'prev', 'nextAll', 'prevAll'];
  for (const options of [undefined, { xml: true }]) {
    const read = (loadDocument) => {
      const $ = loadDocument(html, options);
      const nodes = [];
      const walk = (node) => { nodes.push(node); for (const child of node.children ?? []) walk(child); };
      walk($.root()[0]);
      const describe = (selection) => selection.toArray().map((node) => nodes.indexOf(node)).join(',');
      const traverse = () => nodes.filter((node) => node.type === 'tag').flatMap((node) => kinds.map((kind) => describe($(node)[kind]())));
      const before = traverse();
      $('li, h2').attr('data-seen', '1');
      return [before, traverse(), describe($('li').parents()), describe($('h2').siblings())];
    };
    assert.deepEqual(read(load), read(cheerio.load), JSON.stringify(options));
  }
});

test('inserting into selections with text nodes, roots and other documents matches Cheerio', async () => {
  const cheerio = await import('cheerio');
  const read = (library) => {
    const results = [];
    for (const position of ['append', 'prepend', 'before', 'after']) {
      for (const pick of [($) => $('p').contents(), ($) => $('p').contents().first(), ($) => $('p, b').add($('p').contents().last()), ($) => $.root()]) {
        const $ = library.load('<div><p>a<b>b</b>c</p><p>d</p></div>');
        pick($)[position]('<i>x</i>');
        results.push($.html());
        const other = library.load('<span>moved</span>');
        const $2 = library.load('<div><p>a</p></div>');
        pick($2)[position](other('span'));
        results.push($2.html(), other.html());
      }
    }
    return results;
  };
  assert.deepEqual(read({ load }), read(cheerio));
});

test('documents with text too large for snapshots read, select and walk as in Cheerio, also after writes', async () => {
  const cheerio = await import('cheerio');
  const large = `${'終'.repeat(3000)}\ud800 tail`;
  const html = `<main><p id="a">${large}</p><p id="b">x<b>${large}</b>y<!--c--></p><div><span>z</span></div></main>`;
  const read = (library) => {
    const $ = library.load(html);
    const nodes = [];
    const walk = (node) => { nodes.push(node); for (const child of node.children ?? []) walk(child); };
    walk($.root()[0]);
    const results = [nodes.map((node) => `${node.type}:${node.name ?? ''}:${node.data?.length ?? ''}:${node.parent?.name ?? ''}:${node.next?.type ?? ''}`).join('|')];
    results.push($('span').length, $('p').length, $('main p b').length, $('b').text().length);
    for (const id of ['a', 'b']) results.push($(`#${id}`).text(), $(`#${id}`).text());
    results.push($('main').text());
    $('#a').contents()[0].data = 'changed';
    results.push($('#a').text(), $('main').text().length);
    $('#b b').text('short');
    results.push($('#b').text(), $('main').text().length, $.html().length);
    return results;
  };
  assert.deepEqual(read({ load }), read(cheerio));
});

test('XML queries by element name stay correct after attribute writes', async () => {
  const cheerio = await import('cheerio');
  const xml = `<feed>${Array.from({ length: 30 }, (_, i) => `<entry id="e${i}"><title>t${i}</title><link href="/${i}"/></entry>`).join('')}</feed>`;
  const read = (library) => {
    const $ = library.load(xml, { xml: true });
    const results = [$('entry title').length];
    $('entry').each((index, element) => { $(element).attr('data-i', String(index)); });
    $('link').removeAttr('href').addClass('seen').css('color', 'red');
    $('title').toggleClass('t');
    results.push($('entry').length, $('entry title').length, $('link.seen').length, $('[data-i="3"] title').text(), $.xml());
    $('entry').first().remove();
    $('feed').append('<entry><title>new</title></entry>');
    results.push($('entry').length, $('entry title').map((_, element) => $(element).text()).get().join());
    return results;
  };
  assert.deepEqual(read({ load }), read(cheerio));
});

test('documents large enough to snapshot in parallel read as in Cheerio', async () => {
  const cheerio = await import('cheerio');
  const xml = `<feed>${Array.from({ length: 6000 }, (_, i) => `<entry id="e${i}" data-n="${i % 7}"><title>t${i} café 終</title><!--c${i}--><link href="/${i}"/><![CDATA[d${i}]]></entry>`).join('')}</feed>`;
  const read = (library) => {
    const $ = library.load(xml, { xml: true });
    const nodes = [];
    const walk = (node) => {
      nodes.push([node.type, node.name, node.data, node.attribs && Object.entries(node.attribs), node.parent?.name, node.prev?.type]);
      for (const child of node.children ?? []) walk(child);
    };
    walk($.root()[0]);
    return [nodes, $('entry[data-n="3"] title').map((_, element) => $(element).text()).get().length, $('link').last().attr('href')];
  };
  assert.deepEqual(read({ load }), read(cheerio));
});

test('XML elements with many or repeated attributes keep each first value as in Cheerio', async () => {
  const cheerio = await import('cheerio');
  const many = Array.from({ length: 40 }, (_, i) => `a${i % 25}="${i}"`).join(' ');
  const xml = `<root><item ${many} b="1" b="2"/><small c="1" c="2" d="3"/><plain/></root>`;
  const read = (library) => {
    const $ = library.load(xml, { xml: true });
    return [{ ...$('item')[0].attribs }, { ...$('small')[0].attribs }, { ...$('plain')[0].attribs }, $.xml(), $('[a3="3"]').length, $('[c="1"]').length, $('item').attr('a24')];
  };
  assert.deepEqual(read({ load }), read(cheerio));
});
