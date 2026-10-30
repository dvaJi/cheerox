import { parentPort } from 'node:worker_threads';
import * as cheerio from 'cheerio';
import { mapFor } from './fixtures.mjs';

parentPort.on('message', ({ id, documents, mode, gc, requireGc }) => {
  try {
    if (gc) {
      if (requireGc && typeof globalThis.gc !== 'function') throw new Error('Benchmark Cheerio workers require --expose-gc');
      globalThis.gc?.(); parentPort.postMessage({ id }); return;
    }
    const result = documents.map((html) => cheerio.load(html).extract(mapFor(mode)));
    parentPort.postMessage({ id, result });
  } catch (error) { parentPort.postMessage({ id, error: error.stack ?? String(error) }); }
});
parentPort.postMessage({ ready: true });
