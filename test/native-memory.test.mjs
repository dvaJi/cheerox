import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const moduleUrl = new URL('../dist/modern.mjs', import.meta.url).href;

function run(source, timeout = 30000) {
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {load} from ${JSON.stringify(moduleUrl)};
    const tick=()=>new Promise(resolve=>setImmediate(resolve));
    async function collect() { for(let i=0;i<10;i++){await tick();global.gc();}await tick(); }
    ${source}
  `], { encoding: 'utf8', timeout });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return result.stdout.trim();
}

test('repeated mutations reclaim native detached subtrees while a live API remains', (context) => {
  context.diagnostic(run(`
    const $=load('<main><p>initial</p></main>');
    const document=$('main')._document;
    for(let round=0;round<20;round++) {
      $('main').html('<article><h2>heading</h2><p>body</p></article>'.repeat(150));
      $('article').each((index,node)=>{$(node).data('round',round)});
      $('main').empty();
      await collect();
    }
    const stats=document.collectGarbage();
    assert.ok(stats && stats.live < 30, JSON.stringify(stats));
    assert.ok(stats.slots < 1500, 'detached slots not recycled: '+JSON.stringify(stats));
    assert.equal($('main').html(),'');
    console.log(JSON.stringify(stats));
  `));
});

test('a held detached child preserves ancestry and is reclaimed once released', (context) => {
  context.diagnostic(run(`
    const $=load('<main><article><h2>held</h2><p>sibling</p></article></main>');
    let held=$('h2');
    $('article').remove();
    await collect();
    assert.equal(held.parent().find('p').text(),'sibling');
    held.text('alive');assert.equal(held.text(),'alive');
    held=null;
    const document=$('main')._document;
    document.collectGarbage();
    await collect();
    const stats=document.collectGarbage();
    assert.ok(stats.live < 10,JSON.stringify(stats));
    let detached;
    (()=>{
      const source=load('<main>'+ '<p>unrelated</p>'.repeat(2000) +'<section>kept</section></main>');
      detached=source('section').remove()[0];
    })();
    await collect();
    assert.equal(detached.children[0].data,'kept');
    assert.equal(detached.parent,null);
    console.log(JSON.stringify({liveAfterSelectionRelease:stats.live}));
  `));
});

test('native document memory is reported to V8 so idle documents are collected without explicit GC', (context) => {
  context.diagnostic(run(`
    const rows=20000;
    const html='<main>'+'<p class="row">text <b>bold</b></p>'.repeat(rows)+'</main>';
    const probe=load(html);
    const reported=probe('main')._document.collectGarbage().externalBytes;
    assert.ok(reported>=html.length,'native document size not reported: '+reported);
    const {stringStream}=await import(${JSON.stringify(moduleUrl)});
    const script='<script>'+'x'.repeat(2000000)+'</script>';
    const streamed=await new Promise((resolve,reject)=>{const stream=stringStream({},(error,$)=>error?reject(error):resolve($));stream.end(script);});
    const streamedBytes=streamed.root()._document.collectGarbage().externalBytes;
    assert.ok(streamedBytes>=2000000,'streamed document content not reported: '+streamedBytes);
    let finalized=0, peakLive=0;
    const registry=new FinalizationRegistry(()=>{finalized++;});
    const count=60;
    for(let index=0;index<count;index++){
      const $=load(html);
      registry.register($('main')._document.raw,index);
      assert.equal($('p').length,rows);
      await tick();
      peakLive=Math.max(peakLive,index+1-finalized);
    }
    assert.ok(peakLive<count/2,'unreachable documents accumulated: '+JSON.stringify({peakLive,finalized}));
    console.log(JSON.stringify({reported,peakLive,finalized}));
  `, 120000));
});

test('documents loaded in a synchronous loop are released without yielding', (context) => {
  context.diagnostic(run(`
    const html='<main>'+'<p class="row">text <b>bold</b> <a href="/x">link</a></p>'.repeat(20000)+'</main>';
    let peak=0, raw;
    for(let index=0;index<40;index++){
      const $=load(html);
      raw=$('main')._document.raw;
      assert.equal($('p').length,20000);
      $('b').remove();
      assert.ok($('main').text().length>0);
      global.gc();
      peak=Math.max(peak,raw.liveDocumentCount());
    }
    assert.ok(peak<8,'documents accumulated during a synchronous loop: '+peak);
    console.log(JSON.stringify({peakLiveDocuments:peak}));
  `, 120000));
});
