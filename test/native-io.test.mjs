import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import * as reference from 'cheerio';
import * as cheerox from '../dist/modern.mjs';

test('native buffer decoding preserves encoding precedence and XML declarations', () => {
  const utf8 = Buffer.from('<meta charset="windows-1252"><p>café 😀</p>');
  const xml = '<?xml version="1.0"?><p>café</p>';
  const samples = [
    [utf8, { encoding: { userEncoding: 'utf-8', transportLayerEncodingLabel: 'windows-1252' } }],
    [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]), { encoding: { userEncoding: 'windows-1252' } }],
    [Buffer.from('<!--<meta charset="utf-8">--><p>caf\xe9</p>', 'latin1'), {}],
    [Buffer.from('<meta content="text/html; charset=utf-8" http-equiv="Content-Type"><p>café</p>'), {}],
    [Buffer.from('<?xml version="1.0" encoding="iso-8859-1"?><p>caf\xe9</p>', 'latin1'), { xml: true }],
    [Buffer.from(xml, 'utf16le'), { xml: true }],
    [Buffer.from(xml, 'utf16le').swap16(), { xml: true }],
    [Buffer.from('<meta charset="x-user-defined"><p>caf\xe9</p>', 'latin1'), {}],
  ];
  for (const [buffer, options] of samples) {
    assert.equal(cheerox.loadBuffer(buffer, options)('p').text(), reference.loadBuffer(buffer, options)('p').text());
  }
});

test('native decode streams preserve multibyte characters and BOMs across single-byte chunks', async () => {
  const html = '<p>café 😀</p>';
  const buffer = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(html, 'utf16le').swap16()]);
  const document = await new Promise((resolve, reject) => {
    const stream = cheerox.decodeStream({}, (error, document) => error ? reject(error) : resolve(document));
    for (const byte of buffer) stream.write(Buffer.from([byte]));
    stream.end();
  });
  assert.equal(document('p').text(), 'café 😀');
  const strings = await new Promise((resolve, reject) => {
    const stream = cheerox.stringStream({}, (error, document) => error ? reject(error) : resolve(document));
    for (let offset = 0; offset < html.length; offset += 1) stream.write(html.slice(offset, offset + 1));
    stream.end();
  });
  assert.equal(strings('p').text(), 'café 😀');
});

test('native URL loading honors user encodings, request headers and redirect limits', async () => {
  let redirects = 0;
  const server = createServer((request, response) => {
    if (request.url === '/loop') {
      redirects += 1;
      response.writeHead(302, { location: '/loop' }).end();
    } else {
      assert.equal(request.headers['x-test'], 'native');
      response.writeHead(200, { 'content-type': 'text/html; charset=windows-1252' }).end('<p>café</p>');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const options = { requestOptions: { method: 'GET', headers: { 'x-test': 'native' } }, encoding: { userEncoding: 'utf-8' } };
    const actual = await cheerox.fromURL(`http://127.0.0.1:${port}/`, options);
    const expected = await reference.fromURL(`http://127.0.0.1:${port}/`, options);
    assert.equal(actual('p').text(), expected('p').text());
    assert.equal(actual('p').text(), 'café');
    await assert.rejects(cheerox.fromURL(`http://127.0.0.1:${port}/loop`), /redirect/i);
    assert.ok(redirects <= 6);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
