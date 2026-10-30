import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { FormData as UndiciFormData } from 'undici';
import * as reference from 'cheerio';
import * as rusteerio from '../dist/modern.mjs';

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

async function outcome(library, url, requestOptions = {}) {
  try {
    // These cases compare HTTP semantics. Shared CI runners can spend seconds
    // initializing Undici, so keep their deadline separate from timeout tests.
    const $ = await library.fromURL(url, { requestOptions: { method: 'GET', headersTimeout: 5000, bodyTimeout: 5000, signal: AbortSignal.timeout(15000), ...requestOptions } });
    return { html: $.html() };
  } catch (error) {
    return { name: error.name, code: error.code, message: error.message, statusCode: error.statusCode };
  }
}

test('303 redirects preserve HEAD while replacing POST and its content headers', async () => {
  const requests = [];
  await withServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, type: request.headers['content-type'], length: request.headers['content-length'], language: request.headers['content-language'], body: await requestBody(request) });
    if (request.url === '/start') return response.writeHead(303, { location: `http://${request.headers.host}/final` }).end();
    response.writeHead(200, { 'content-type': 'text/html' }).end('<p>final</p>');
  }, async base => {
    for (const method of ['HEAD', 'POST']) {
      const run = async library => {
        requests.length = 0;
        const result = await outcome(library, `${base}/start`, { method, headers: { 'content-type': 'text/plain', 'content-language': 'en' }, ...(method === 'POST' ? { body: 'payload' } : {}) });
        return { result, requests: structuredClone(requests) };
      };
      const expected = await run(reference);
      assert.equal(typeof expected.result.html, 'string', JSON.stringify(expected.result));
      assert.deepEqual(await run(rusteerio), expected, method);
    }
  });
});

test('300 redirects follow the same method and buffered body as Cheerio', async () => {
  const requests = [];
  await withServer(async (request, response) => {
    requests.push({ method: request.method, body: await requestBody(request) });
    if (request.url === '/start') return response.writeHead(300, { location: `http://${request.headers.host}/final`, 'content-type': 'text/html' }).end('<p>choices</p>');
    response.writeHead(200, { 'content-type': 'text/html' }).end('<p>final</p>');
  }, async base => {
    const run = async library => {
      requests.length = 0;
      const result = await outcome(library, `${base}/start`, { method: 'POST', body: 'payload' });
      return { result, requests: structuredClone(requests) };
    };
    const expected = await run(reference);
    assert.equal(typeof expected.result.html, 'string', JSON.stringify(expected.result));
    assert.deepEqual(await run(rusteerio), expected);
  });
});

test('307 redirects do not replay an already consumed Node request stream', async () => {
  const requests = [];
  await withServer(async (request, response) => {
    requests.push({ method: request.method, body: await requestBody(request) });
    if (request.url === '/start') return response.writeHead(307, { location: `http://${request.headers.host}/final`, 'content-type': 'text/html' }).end('<p>temporary</p>');
    response.writeHead(200, { 'content-type': 'text/html' }).end('<p>final</p>');
  }, async base => {
    const run = async library => {
      requests.length = 0;
      const result = await outcome(library, `${base}/start`, { method: 'POST', body: Readable.from(['streamed ', 'payload']) });
      return { result, requests: structuredClone(requests) };
    };
    const expected = await run(reference);
    assert.equal(expected.result.statusCode, 307);
    assert.deepEqual(await run(rusteerio), expected);
  });
});

test('307 FormData redirects preserve a boundary consistent with each request body', async () => {
  const requests = [];
  await withServer(async (request, response) => {
    const body = await requestBody(request);
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(request.headers['content-type'] ?? '');
    const delimiter = boundary?.[1] ?? boundary?.[2];
    requests.push({ method: request.method, validBoundary: !!delimiter && body.startsWith(`--${delimiter}\r\n`) && body.endsWith(`--${delimiter}--\r\n`), field: body.includes('name="title"\r\n\r\nhello\r\n'), file: body.includes('name="file"; filename="entry.txt"\r\nContent-Type: text/plain\r\n\r\nfile body\r\n') });
    if (request.url === '/start') return response.writeHead(307, { location: `http://${request.headers.host}/final` }).end();
    response.writeHead(200, { 'content-type': 'text/html' }).end('<p>final</p>');
  }, async base => {
    const run = async library => {
      requests.length = 0;
      const body = new UndiciFormData();
      body.set('title', 'hello');
      body.set('file', new Blob(['file body'], { type: 'text/plain' }), 'entry.txt');
      const result = await outcome(library, `${base}/start`, { method: 'POST', body });
      return { result, requests: structuredClone(requests) };
    };
    const expected = await run(reference);
    assert.equal(typeof expected.result.html, 'string', JSON.stringify(expected.result));
    assert.equal(expected.requests.length, 2);
    assert.ok(expected.requests.every(request => request.validBoundary && request.field && request.file));
    assert.deepEqual(await run(rusteerio), expected);
  });
});

test('request Content-Length mismatches reject with the Undici-compatible error', async () => {
  await withServer((request, response) => {
    request.resume();
    request.on('error', () => {});
    request.once('end', () => response.writeHead(200, { 'content-type': 'text/html' }).end('<p>received</p>'));
  }, async base => {
    for (const length of ['3', '9']) {
      for (const createBody of [() => 'hello', () => Buffer.from('hello'), () => Readable.from(['he', 'llo'])]) {
        const expected = await outcome(reference, base, { method: 'POST', headers: { 'content-length': length }, body: createBody() });
        assert.equal(expected.code, 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH');
        assert.deepEqual(await outcome(rusteerio, base, { method: 'POST', headers: { 'content-length': length }, body: createBody() }), expected);
      }
    }
  });
});

test('duplicate Content-Type uses its first value for successful MIME selection', async () => {
  await withServer((_request, response) => response.writeHead(200, ['Content-Type', 'application/xml; charset=utf-8', 'Content-Type', 'text/html']).end('<Root><Item>café</Item></Root>'), async base => {
    const expected = await outcome(reference, base);
    assert.equal(typeof expected.html, 'string', JSON.stringify(expected));
    assert.deepEqual(await outcome(rusteerio, base), expected);
  });
});

test('non-success ResponseError retains all duplicate raw response header values', async () => {
  await withServer((_request, response) => response.writeHead(418, ['Content-Type', 'text/html', 'Content-Type', 'application/xml', 'X-Multi', 'one', 'X-Multi', 'two', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2']).end('<p>teapot</p>'), async base => {
    const run = async library => {
      try { await library.fromURL(base); assert.fail('expected ResponseError'); }
      catch (error) {
        return { name: error.name, code: error.code, statusCode: error.statusCode, headers: { type: error.headers?.['content-type'], multi: error.headers?.['x-multi'], cookies: error.headers?.['set-cookie'] } };
      }
    };
    assert.deepEqual(await run(rusteerio), await run(reference));
  });
});
