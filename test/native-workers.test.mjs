import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const moduleURL = new URL('../dist/index.mjs', import.meta.url).href;
async function isolated(source, environment = {}) {
  return execute(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; import * as r from ${JSON.stringify(moduleURL)}; ${source}`], {
    env: { ...process.env, ...environment }, timeout: 30000,
  });
}

test('global worker limits cover simultaneous batches and streaming parsers', async () => {
  for (const threads of [1, 2]) await isolated(`
    assert.equal(r.configureWorkers({threads:${threads}}).threads, ${threads});
    const inputs = Array.from({length:12}, (_,i)=>('<article><h2>'+i+'</h2></article>').repeat(80));
    const streams = Array.from({length:3},()=>new Promise((resolve,reject)=>{
      const parser=r.stringStream({},(error,$)=>error?reject(error):resolve($('article').length));
      for(const input of inputs) parser.write(input);
      parser.end();
    }));
    const batches = Array.from({length:6},()=>r.extractAll(inputs,{titles:['h2']},{threads:8}));
    const results = await Promise.all([...batches,...streams]);
    for(const batch of results.slice(0,6)) batch.forEach((row,i)=>assert.deepEqual(row.titles,Array(80).fill(String(i))));
    assert.deepEqual(results.slice(6),[960,960,960]);
    const info=r.workerPoolInfo();
    assert.equal(info.threads,${threads});
    assert.equal(info.activeBatches,0); assert.equal(info.activeWorkers,0);
    assert.ok(info.peakActiveWorkers>0 && info.peakActiveWorkers<=${threads},JSON.stringify(info));
    assert.equal(r.configureWorkers(${threads}).threads,${threads});
    assert.throws(()=>r.configureWorkers(${threads}+1),/before starting/);
  `);
});

test('worker configuration validates limits and environment defaults before initialization', async () => {
  await isolated(`
    for(const value of [0,-1,1.5,257,NaN,Infinity,'2',null,undefined]) assert.throws(()=>r.configureWorkers(value),RangeError);
    assert.equal(r.workerPoolInfo().threads,2);
    assert.equal(r.configureWorkers(1).threads,1);
    await r.loadAsync('<p>configured</p>');
    assert.equal(r.workerPoolInfo().threads,1);
  `, { CHEEROX_THREADS: '2' });
  await isolated(`
    await assert.rejects(r.loadAsync('<p>invalid</p>'),/CHEEROX_THREADS/);
    r.configureWorkers(1);
    assert.equal((await r.loadAsync('<p>recovered</p>'))('p').text(),'recovered');
  `, { CHEEROX_THREADS: 'zero' });
});

test('synchronous work on large documents leaves the worker budget configurable', async () => {
  await isolated(`
    const html='<main>'+'<p class="row">text <b>bold</b></p>'.repeat(20000)+'</main>';
    for(let round=0;round<3;round++){
      const $=r.load(html);
      $('b').remove();
      assert.equal($('p').length,20000);
    }
    assert.equal(r.configureWorkers(1).threads,1);
    const $=r.load(html);
    $('p').first().remove();
    assert.equal(r.workerPoolInfo().threads,1);
    assert.equal((await r.extractAll([html],{count:['p.row']}))[0].count.length,20000);
    assert.throws(()=>r.configureWorkers(2),/before starting/);
  `, { CHEEROX_THREADS: '4' });
});

test('concurrent batches that copy large documents on workers keep finishing', async () => {
  await isolated(`
    r.configureWorkers({ threads: 4 });
    const big = '<main>' + '<section><p>a <b>b</b></p><a href="/x">x</a></section>'.repeat(2000) + '</main>';
    const small = Array.from({ length: 16 }, (_, i) => '<p>' + i + '</p>');
    const map = { body: { selector: 'body', value: 'innerHTML' } };
    const inflight = new Set();
    let finished = 0;
    const spawn = (work) => { const promise = work().then(() => { finished++; inflight.delete(promise); }); inflight.add(promise); };
    for (let i = 0; finished < 300; i++) {
      while (inflight.size < 12) {
        i++;
        if (i % 3 === 0) spawn(() => r.extractAll([big], map, { threads: 1 }));
        else if (i % 3 === 1) spawn(() => r.loadAll(small, { threads: 4 }));
        else spawn(() => r.extractAll([big, small[0]], map, { threads: 2 }));
      }
      await Promise.race(inflight);
    }
    await Promise.all(inflight);
  `);
});
