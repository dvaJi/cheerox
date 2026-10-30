import assert from 'node:assert/strict';
import test from 'node:test';
import * as cheerio from 'cheerio';
import { CheerioPool } from './worker-pool.mjs';
import { documentOf, mapFor } from './fixtures.mjs';

test('reused Cheerio workers preserve ordering, callback results, and one global concurrency bound', async () => {
  const pool = new CheerioPool(2);
  try {
    const documents = Array.from({ length: 7 }, (_, index) => documentOf(3, index));
    for (const mode of ['simple', 'nestedCallback']) {
      const expected = documents.map((html) => cheerio.load(html).extract(mapFor(mode)));
      const batches = await Promise.all(Array.from({ length: 8 }, () => pool.run(documents, mode)));
      for (const batch of batches) assert.deepEqual(batch, expected);
    }
    assert.equal(pool.info().peakActiveWorkers, 2);
    assert.equal(pool.info().activeWorkers, 0);
    await pool.gc();
    assert.deepEqual(await pool.run([], 'simple'), []);
  } finally { await pool.close(); }
});

test('worker task failures reject their batch and leave the reusable pool usable', async () => {
  const pool = new CheerioPool(1);
  try {
    await assert.rejects(pool.run([null], 'simple'), /expects a string/);
    const html = documentOf(2);
    assert.deepEqual(await pool.run([html], 'simple'), [cheerio.load(html).extract(mapFor('simple'))]);
  } finally { await pool.close(); }
});
