import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { Socket } from 'node:net';
import { test } from 'node:test';
import { Agent } from 'undici';
import * as reference from 'cheerio';
import * as cheerox from '../dist/modern.mjs';

async function serverFixture(handler, work) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await work(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

function streamed(api, buffer, options, step) {
  return new Promise((resolve, reject) => {
    const parser = api.decodeStream(options, (error, $) => error ? reject(error) : resolve($));
    for (let index = 0; index < buffer.length; index += step) parser.write(buffer.subarray(index, index + step));
    parser.end();
  });
}

test('incremental decoding matches Cheerio across sniffing and character boundaries', async () => {
  const html = '<p>café 😀 €</p>';
  const samples = [
    [Buffer.from('<meta charset="utf-8">' + html), {}],
    [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(html)]), { encoding: { userEncoding: 'windows-1252' } }],
    [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(html, 'utf16le')]), {}],
    [Buffer.from('<?xml version="1.0" encoding="utf-8"?>' + html), { xml: true }],
    [Buffer.from('<meta http-equiv="content-type" content="text/html; charset=iso-8859-1"><p>caf\xe9\x80</p>', 'latin1'), {}],
    [Buffer.from('<!--<meta charset="utf-8">--><p>caf\xe9</p>', 'latin1'), {}],
    [Buffer.from('<meta charset="utf-8"><p>café</p>'), { encoding: { maxBytes: 2 } }],
  ];
  for (const [buffer, options] of samples) for (const step of [1, 3, 17, 1024]) {
    const [actual, expected] = await Promise.all([streamed(cheerox, buffer, options, step), streamed(reference, buffer, options, step)]);
    assert.equal(actual.html(), expected.html(), `chunk size ${step}: ${buffer.toString('hex')}`);
  }
});

test('string stream delivers parser errors before finish and propagates callback failures once', async () => {
  const errors = [];
  let completions = 0;
  const finished = new Promise((resolve, reject) => {
    const parser = cheerox.stringStream({ onParseError(error) { errors.push(error); } }, (error, $) => {
      completions++; error ? reject(error) : resolve($);
    });
    parser.write('<p a=1 a=2>hello</p>', error => {
      if (error) return reject(error);
      assert.ok(errors.some(error => error.code === 'duplicate-attribute'));
      parser.end();
    });
  });
  assert.equal((await finished)('p').text(), 'hello');
  assert.equal(completions, 1);
  const original = new Error('user hook failed');
  await new Promise(resolve => {
    const parser = cheerox.stringStream({ onParseError() { throw original; } }, (error) => {
      assert.equal(error, original); completions++; resolve();
    });
    parser.write('<p>', error => assert.equal(error, original));
  });
  assert.equal(completions, 2);
});

test('fromURL streams responses, resolves redirected baseURI, and preserves status rejection', async () => {
  await serverFixture((request, response) => {
    if (request.url === '/redirect') return response.writeHead(302, { location: `http://${request.headers.host}/page` }).end();
    if (request.url === '/missing') return response.writeHead(404, { 'content-type': 'text/html' }).end('<p>missing</p>');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.write('<!doctype html><p>café ');
    setImmediate(() => response.end('😀</p><a href="next">next</a>'));
  }, async base => {
    const actual = await cheerox.fromURL(`${base}/redirect`);
    const expected = await reference.fromURL(`${base}/redirect`);
    assert.equal(actual.html(), expected.html());
    assert.equal(actual('a').prop('href'), `${base}/next`);
    for (const api of [reference, cheerox]) await assert.rejects(api.fromURL(`${base}/missing`), error => error.statusCode === 404 && error.code === 'UND_ERR_RESPONSE');
    await assert.rejects(cheerox.fromURL(`${base}/missing`, { requestOptions: { throwOnError: false } }), error => error.statusCode === 404 && error.code === 'UND_ERR_RESPONSE');
  });
});

test('fromURL enforces header/body timeouts, response limits and abort signals', async () => {
  await serverFixture((request, response) => {
    if (request.url === '/headers') return;
    response.writeHead(200, { 'content-type': 'text/html' });
    response.write('<p>');
    if (request.url === '/large') response.end('x'.repeat(4096) + '</p>');
  }, async base => {
    await assert.rejects(cheerox.fromURL(`${base}/headers`, { requestOptions: { headersTimeout: 30 } }), error => error.code === 'UND_ERR_HEADERS_TIMEOUT');
    await assert.rejects(cheerox.fromURL(`${base}/body`, { requestOptions: { bodyTimeout: 30 } }), error => error.code === 'UND_ERR_BODY_TIMEOUT');
    await assert.rejects(cheerox.fromURL(`${base}/large`, { requestOptions: { maxResponseSize: 100 } }), error => error.code === 'UND_ERR_RES_EXCEEDED_MAX_SIZE');
    const controller = new AbortController();
    const pending = cheerox.fromURL(`${base}/body`, { requestOptions: { signal: controller.signal } });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  });
});

test('fromURL supports a caller dispatcher without installing runtime dependencies', async () => {
  const agent = new Agent();
  const requests = [];
  const dispatcher = { dispatch(options, handler) { requests.push(options); return agent.dispatch(options, handler); } };
  try {
    await serverFixture((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end('<p>transport</p>'), async base => {
      const $ = await cheerox.fromURL(base, { requestOptions: { dispatcher, headersTimeout: 2000, bodyTimeout: 2000 } });
      assert.equal($('p').text(), 'transport');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].headersTimeout, 2000);
      assert.equal(requests[0].bodyTimeout, 2000);
    });
  } finally { await agent.close(); }
});

test('HTTP options accept Cheerio header forms, query serialization and streaming request bodies', async () => {
  await serverFixture(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.writeHead(200, { 'content-type': 'text/html' }).end(`<p>${request.url}|${request.headers['x-values']}|${body}</p>`);
  }, async base => {
    for (const headers of [{ 'x-values': ['one', 'two'] }, ['x-values', 'one', 'x-values', 'two'], new Map([['x-values', ['one', 'two']]])]) {
      const $ = await cheerox.fromURL(base, { requestOptions: { method: 'POST', headers, query: { q: ['one', 'two'], count: 3 }, body: Readable.from(['streamed ', 'body']) } });
      assert.equal($('p').text(), '/?q=one&q=two&count=3|one, two|streamed body');
    }
    await assert.rejects(cheerox.fromURL(`${base}/?existing=1`, { requestOptions: { query: { extra: 2 } } }), /query/i);
  });
  await serverFixture((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.write('<p>'); }, async base => {
    const signal = new EventEmitter();
    const pending = cheerox.fromURL(base, { requestOptions: { signal } });
    signal.emit('abort');
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(signal.listenerCount('abort'), 0);
  });
});

test('URL MIME parsing follows quoted charset rules and updates supplied encoding options', async () => {
  await serverFixture((request, response) => {
    const type = request.url === '/invalid' ? 'invalid' : request.url === '/empty' ? 'text/html' : 'Text/HTML; charset="utf\\-8"';
    response.writeHead(200, { 'content-type': type }).end('<p>café 😀</p>');
  }, async base => {
    for (const path of ['/quoted', '/empty']) {
      const actualOptions = { encoding: { defaultEncoding: 'utf-8' } };
      const expectedOptions = { encoding: { defaultEncoding: 'utf-8' } };
      const actual = await cheerox.fromURL(base + path, actualOptions);
      const expected = await reference.fromURL(base + path, expectedOptions);
      assert.equal(actual.html(), expected.html());
      assert.deepEqual(actualOptions, expectedOptions);
    }
    for (const library of [reference, cheerox]) await assert.rejects(library.fromURL(base + '/invalid'), { name: 'Error', message: 'Could not parse MIME type string "invalid"' });
  });
});

test('URL transport preserves caller header negotiation and informational callbacks', async () => {
  const received = [];
  await serverFixture((request, response) => {
    received.push({ accept: request.headers.accept, encoding: request.headers['accept-encoding'], agent: request.headers['user-agent'] });
    response.writeEarlyHints({ link: '</style.css>; rel=preload; as=style' });
    response.writeHead(200, { 'content-type': 'text/html' }).end('<p>hints</p>');
  }, async base => {
    for (const headers of [undefined, {}, null, [], { 'x-one': 'one' }]) {
      const actualHints = [], expectedHints = [];
      const actual = await cheerox.fromURL(base, { requestOptions: { method: 'GET', headers, onInfo: info => actualHints.push(info) } });
      const expected = await reference.fromURL(base, { requestOptions: { method: 'GET', headers, onInfo: info => expectedHints.push(info) } });
      assert.equal(actual.html(), expected.html());
      assert.deepEqual(actualHints, expectedHints);
      assert.deepEqual(received.at(-2), received.at(-1));
      assert.equal(actualHints[0].statusCode, 103);
    }
    const original = new Error('informational callback');
    await assert.rejects(cheerox.fromURL(base, { requestOptions: { onInfo() { throw original; } } }), error => error === original);
  });
});

test('URL transport only calls optional socket TOS setters with a configured number', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Socket.prototype, 'setTypeOfService');
  const values = [];
  Object.defineProperty(Socket.prototype, 'setTypeOfService', { configurable: true, value(value) { assert.equal(typeof value, 'number'); values.push(value); } });
  try {
    await serverFixture((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end('<p>socket</p>'), async base => {
      for (const options of [{}, { typeOfService: undefined }, { typeOfService: null }, { typeOfService: 0 }, { typeOfService: 16 }]) {
        assert.equal((await cheerox.fromURL(base, { requestOptions: options }))('p').text(), 'socket');
      }
      assert.deepEqual(values, [0, 16]);
      for (const typeOfService of [-1, 256, 0.5, NaN, Infinity]) {
        await assert.rejects(cheerox.fromURL(base, { requestOptions: { typeOfService } }), { name: 'InvalidArgumentError', code: 'UND_ERR_INVALID_ARG' });
      }
      assert.deepEqual(values, [0, 16]);
    });
  } finally {
    if (descriptor) Object.defineProperty(Socket.prototype, 'setTypeOfService', descriptor);
    else delete Socket.prototype.setTypeOfService;
  }
});
