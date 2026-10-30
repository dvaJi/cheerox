import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { adapter } from 'parse5-htmlparser2-tree-adapter';
import { Element as ForeignElement } from 'domhandler';
import * as cheerio from 'cheerio';
import * as rusteerio from '../dist/modern.mjs';

const moduleUrl = new URL('../dist/modern.mjs', import.meta.url).href;
const require = createRequire(import.meta.url);
const adapterUrl = pathToFileURL(require.resolve('parse5-htmlparser2-tree-adapter')).href;

/** Runs `source` in a fresh process where collections can be forced. */
function run(source) {
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {load} from ${JSON.stringify(moduleUrl)};
    const tick=()=>new Promise(resolve=>setImmediate(resolve));
    async function collect() { for(let i=0;i<6;i++){await tick();global.gc();}await tick(); }
    ${source}
  `], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
}

test('a large selection keeps working after its nodes move to another document', () => {
  for (const library of [rusteerio, cheerio]) {
    const $a = library.load(`<ul>${'<li>x</li>'.repeat(20)}</ul>`);
    const $b = library.load('<section></section>');
    const items = $a('li');
    $b('section').append(items);
    items.addClass('moved');
    assert.equal(items.text(), 'x'.repeat(20));
    assert.equal(items.parent().length, 1);
    assert.equal(items.is('.moved'), true);
    assert.equal($b('li.moved').length, 20);
  }
});

test('selections holding nodes of a released document keep that document', () => run(`
  const $a=load('<p>a-para</p>');
  let combined, wrapped;
  (()=>{
    const $b=load('<ul>'+Array.from({length:20},(_,i)=>'<li>b'+i+'</li>').join('')+'</ul>');
    combined=$a('p').add($b('li'));
    wrapped=$a($b('li').toArray());
  })();
  const expected=Array.from({length:20},(_,i)=>'b'+i).join('');
  await collect();
  for(let round=0;round<5;round++){ const $c=load('<ol>'+'<li>OTHER</li>'.repeat(30)+'</ol>'); $a($c('ol')); }
  await collect();
  assert.equal(combined.text(),'a-para'+expected);
  assert.equal(wrapped.text(),expected);
`));

test('wrap moves a wrapper from another document around the element', () => {
  const read = (library) => {
    const $a = library.load('<div><p>keep me</p></div>');
    const $b = library.load('<span><i></i></span>');
    $a('p').wrap($b('span'));
    return [$a('div').html(), $b.html()];
  };
  assert.deepEqual(read(rusteerio), read(cheerio));
});

test('nodes created into freed slots stay intact while held', () => run(`
  const $=load('<main>'+'<div>x</div>'.repeat(50)+'</main>');
  const document=$('main')._document;
  const held=[];
  for(let round=0;round<6;round++){
    $('main').html('<div>filler</div>'.repeat(400));
    await collect();
    document.collectGarbage();
    held.push($('<article id="r'+round+'"><i>fragment '+round+'</i></article>'));
  }
  $('main').html('<section><b>someone else</b></section>'.repeat(50));
  await collect(); document.collectGarbage(); await collect(); document.collectGarbage();
  held.forEach((selection,round)=>{
    assert.equal(selection.attr('id'),'r'+round);
    assert.equal(selection.html(),'<i>fragment '+round+'</i>');
    assert.equal(selection[0].name,'article');
  });
`));

test('removed nodes reached later through a held node stay intact', () => run(`
  const $=load('<main><article><h2>held heading</h2><p>body</p></article></main>');
  let article=$('article').remove()[0];
  const document=$('main')._document;
  await collect(); document.collectGarbage();
  let heading=article.children[0];
  article=null;
  await collect(); document.collectGarbage(); await collect(); document.collectGarbage();
  assert.equal(heading.name,'h2');
  assert.equal($(heading).text(),'held heading');
  assert.equal(heading.parent.name,'article');
`));

test('a node object read late from a removed large selection stays intact', () => run(`
  const $=load('<ul>'+Array.from({length:20},(_,i)=>'<li>item '+i+'</li>').join('')+'</ul>');
  const document=$('ul')._document;
  let items=$('li');
  items.remove();
  await collect(); document.collectGarbage();
  const first=items[0];
  items=null;
  await collect(); document.collectGarbage(); await collect(); document.collectGarbage();
  $('ul').append('<b>new</b>'.repeat(30));
  assert.equal(first.name,'li');
  assert.equal($(first).text(),'item 0');
`));

test('a held node keeps its identity after it is removed, collected around and reinserted', () => run(`
  const $=load('<main><p id="x">a</p>'+'<span>s</span>'.repeat(300)+'</main>');
  const document=$('main')._document;
  const held=$('#x')[0];
  $('#x').remove();
  await collect(); document.collectGarbage(); await collect(); document.collectGarbage();
  $('main').prepend(held);
  $('main').children().each((_,node)=>{ node.attribs; });
  assert.equal($('main')[0].children[0],held);
  assert.equal($('#x')[0],held);
  $('#x').attr('class','updated');
  assert.equal(held.attribs.class,'updated');
`));

test('created nodes held only briefly are reclaimed in a long-lived document', () => run(`
  const $=load('<main></main>');
  const document=$('main')._document;
  const live=[];
  for(let round=0;round<3;round++){
    for(let i=0;i<20000;i++) $('<span class="t">'+i+'</span>').text();
    await collect(); document.collectGarbage(); await collect();
    live.push(document.collectGarbage().live);
  }
  assert.ok(live[2]<live[0]*1.5+1000,JSON.stringify(live));
`));

test('a held data object of a reclaimed node writes nowhere', () => run(`
  const $=load('<main><section></section><section></section></main>');
  const document=$('main')._document;
  let elements=$('section').toArray();
  const bags=elements.map((element)=>$(element).data());
  elements.forEach((element)=>$(element).data('kept','old'));
  $('section').remove();
  elements=null;
  await collect(); document.collectGarbage(); await collect(); document.collectGarbage();
  $('main').append('<section></section>');
  for(const bag of bags) bag.secret='stale';
  assert.equal($('section').data('secret'),undefined);
  assert.equal($('section').data('kept'),undefined);
`));

function recordingAdapter(created) {
  return { ...adapter, createElement(name, namespace, attributes) { const node = adapter.createElement(name, namespace, attributes); created.push(node); return node; } };
}

test('tree adapter nodes of parsed fragments reach the document', () => {
  const read = (library) => {
    const results = [];
    for (const insert of [($) => $('div').append('<p>x</p>'), ($) => $('div').html('<p>x</p>'), ($) => $('div').append($('<p>x</p>'))]) {
      const created = [];
      const $ = library.load('<div></div>', { treeAdapter: recordingAdapter(created) });
      insert($);
      const paragraph = $('p')[0];
      results.push([paragraph instanceof ForeignElement, created.includes(paragraph), $(paragraph).text(), $('p').length, paragraph.parent?.name]);
    }
    return results;
  };
  assert.deepEqual(read(rusteerio), read(cheerio));
});

test('a freed slot does not hand back the tree adapter node it held', () => run(`
  const { adapter } = await import(${JSON.stringify(adapterUrl)});
  const created=[];
  const recording={ ...adapter, createElement(name, namespace, attributes) { const node=adapter.createElement(name, namespace, attributes); created.push(node); return node; } };
  const $=load('<ul>'+'<li>old</li>'.repeat(20)+'</ul>', { treeAdapter: recording });
  const document=$('ul')._document;
  const parsed=new Set(created);
  $('li').remove();
  await collect(); document.collectGarbage(); await collect(); document.collectGarbage();
  $('ul').append('<b>fresh</b>'.repeat(20));
  for(const node of $('b').toArray()){ assert.equal(parsed.has(node),false); assert.equal(node.children[0].data,'fresh'); }
`));

test('each query gets its own root selection', () => {
  const read = (library) => {
    const $ = library.load('<div id="a"><span>1</span></div><span>2</span>');
    const root = $('span').end();
    root[0] = $('#a')[0];
    return [$('span').length, $('p').end() === $('p').end()];
  };
  assert.deepEqual(read(rusteerio), read(cheerio));
});

test('a large selection moved by replaceWith follows its nodes to a third document', () => {
  const read = (library) => {
    const $a = library.load('<ul><li>x</li></ul>');
    const $b = library.load(`<section>${Array.from({ length: 20 }, (_, i) => `<b>b${i}</b>`).join('')}</section>`);
    const $c = library.load('<div></div>');
    const items = $b('b');
    $a('li').replaceWith(items);
    $c('div').append($a('ul'));
    $a('body').append('<i>other</i>'.repeat(30));
    items.attr('title', 'set');
    return [items.text(), items[0].name, $a('[title]').length, $c('[title]').length];
  };
  assert.deepEqual(read(rusteerio), read(cheerio));
});

test('array methods that leave holes in a large selection behave as on Cheerio selections', () => {
  const read = (library) => {
    const $ = library.load(`<ul>${Array.from({ length: 20 }, (_, i) => `<li>${i}</li>`).join('')}</ul>`);
    const lengths = [];
    for (const change of [(items) => items.splice(0, 2), (items) => Array.prototype.shift.call(items), (items) => { delete items[3]; }, (items) => { items.length = 25; }]) {
      const items = $('li');
      change(items);
      lengths.push(items.length);
    }
    return lengths;
  };
  assert.deepEqual(read(rusteerio), read(cheerio));
});

test('a child array read before a node moves documents follows later changes', () => {
  const read = (library) => {
    const $a = library.load('<div id="x"><p>one</p></div>');
    const $b = library.load('<section></section>');
    const moved = $a('#x')[0];
    moved.children;
    $b('section').append(moved);
    $b('#x').append('<p>two</p>');
    $b('#x p').first().remove();
    return moved.children.map((node) => node.children[0].data);
  };
  assert.deepEqual(read(rusteerio), read(cheerio));
});

test('tree adapter nodes keep pointing at their own nodes after moves and collections', () => run(`
  const { adapter } = await import(${JSON.stringify(adapterUrl)});
  const recording = (created) => ({ ...adapter, createElement(name, namespace, attributes) { const node = adapter.createElement(name, namespace, attributes); created.push(node); return node; } });
  let created = [];
  const $a = load('<ul>' + Array.from({ length: 20 }, (_, i) => '<li id="li' + i + '">item ' + i + '</li>').join('') + '</ul>', { treeAdapter: recording(created) });
  const $b = load('<section></section>');
  const first = created.find((node) => node.attribs?.id === 'li0');
  $b('section').append($a('li'));
  $a('ul').append('<b>filler</b>'.repeat(40));
  assert.equal($b(first).text(), 'item 0');
  created = [];
  const $c = load('<ul>' + Array.from({ length: 20 }, (_, i) => '<li id="old' + i + '">old ' + i + '</li>').join('') + '</ul>', { treeAdapter: recording(created) });
  const old = created.find((node) => node.attribs?.id === 'old0');
  $c('ul').empty();
  const document = $c('ul')._document;
  for (let round = 0; round < 6; round++) { await collect(); document.collectGarbage(); }
  $c('ul').append('<b id="fresh">new</b>'.repeat(30));
  $c(old).attr('data-written', 'yes');
  assert.equal($c(old).toString(), '<li id="old0" data-written="yes">old 0</li>');
  assert.equal($c('b[data-written]').length, 0);
`));

test('documents whose nodes were adopted by a long-lived document can be released', () => run(`
  const $ = load('<main></main>');
  const live = () => $('main')._document.raw.liveDocumentCount();
  for (let i = 0; i < 40; i++) {
    const other = load('<ul>' + '<li>x</li>'.repeat(20) + '</ul>');
    $('main').append(other('li'));
    $(other('ul')[0]);
    $('main').empty();
    if (i % 10 === 9) await collect();
  }
  await collect();
  assert.ok(live() <= 3, String(live()));
`));

test('a synchronous loop of documents due for collection keeps only a few alive', () => run(`
  let raw;
  for (let i = 0; i < 40; i++) {
    const $ = load('<main>' + '<p>para</p>'.repeat(3000) + '</main>');
    for (let k = 0; k < 3; k++) $('main').html('<p>new</p>'.repeat(3000));
    raw ??= $('main')._document.raw;
  }
  global.gc();
  assert.ok(raw.liveDocumentCount() <= 6, String(raw.liveDocumentCount()));
`));

test('reading an attribute of a selection starting with a non-node returns undefined', () => {
  const read = (library) => {
    const $ = library.load('<p id="a">x</p>');
    return [$([null, $('p')[0]]).attr('id'), $(['text', $('p')[0]]).attr('id')];
  };
  assert.deepEqual(read(rusteerio), read(cheerio));
});

test('small selections enumerate the same own keys as Cheerio selections', () => {
  const read = (library) => {
    const $ = library.load('<p>a</p><p>b</p>');
    return [Object.keys($('p')), Object.keys($('p').first())];
  };
  assert.deepEqual(read(rusteerio), read(cheerio));
});

test('serializing template content refreshes the template element children array', () => {
  const read = (library) => {
    const $ = library.load('<div><template><p>x</p><i>y</i></template></div>');
    const template = $('template')[0];
    template.children;
    $('template').html();
    return template.children.map((node) => node.name);
  };
  assert.deepEqual(read(rusteerio), read(cheerio));
});

test('selections inspect like Cheerio selections', async () => {
  const { inspect } = await import('node:util');
  const read = (library) => { const $ = library.load('<p>a</p><p>b</p>'); return inspect($('p'), { depth: 0 }); };
  assert.equal(read(rusteerio), read(cheerio));
});

test('a document left out of a synchronous loop\'s pending collections is collected after its next use', () => run(`
  const html = '<main>' + '<section><p>a <b>b</b></p></section>'.repeat(3000) + '</main>';
  const documents = [];
  for (let i = 0; i < 8; i++) {
    const $ = load(html);
    $('section').slice(0, 2900).remove();
    $('main').append('<i>x</i>'.repeat(12000));
    documents.push($);
  }
  await collect();
  documents[0]('main').length;
  await collect();
  assert.equal(documents[0]('main')._document.state.raw.isCollectionDue(), false);
`));
