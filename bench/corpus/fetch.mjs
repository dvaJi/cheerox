import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

/**
 * Builds a corpus of real web pages from one public Common Crawl WARC file:
 * HTTP 200 responses with an HTML content type and a UTF-8 body.
 *
 *   node bench/corpus/fetch.mjs <output directory> [pages] [crawl]
 *
 * The crawl defaults to CC-MAIN-2025-38; any crawl listed at
 * https://data.commoncrawl.org/ works.
 */
const [output = 'bench/corpus/pages', wantedText = '5000', crawl = 'CC-MAIN-2025-38'] = process.argv.slice(2);
const wanted = Number(wantedText);
const base = 'https://data.commoncrawl.org/';
mkdirSync(output, { recursive: true });

const paths = await text(`${base}crawl-data/${crawl}/warc.paths.gz`, true);
const manifest = [];
for (const warcPath of paths.split('\n').filter(Boolean)) {
  if (manifest.length >= wanted) break;
  console.error(`reading ${warcPath}`);
  await readWarc(`${base}${warcPath}`, (url, html) => {
    if (manifest.length >= wanted) return false;
    const file = `${String(manifest.length).padStart(5, '0')}.html`;
    writeFileSync(path.join(output, file), html);
    manifest.push({ file, url, bytes: Buffer.byteLength(html) });
    return true;
  });
}
writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify({ crawl, pages: manifest }, null, 2)}\n`);
console.error(`saved ${manifest.length} pages to ${output}`);

async function text(url, isGzip) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const chunks = [];
  const stream = Readable.fromWeb(response.body);
  for await (const chunk of isGzip ? stream.pipe(createGunzip()) : stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Streams WARC records, passing each HTML response to `accept` until it returns false. */
async function readWarc(url, accept) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const stream = Readable.fromWeb(response.body).pipe(createGunzip());
  let buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = buffer.subarray(0, headerEnd).toString('latin1');
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? NaN);
      if (!Number.isFinite(length)) throw new Error('Malformed WARC record');
      const recordEnd = headerEnd + 4 + length + 4;
      if (buffer.length < recordEnd) break;
      const block = buffer.subarray(headerEnd + 4, headerEnd + 4 + length);
      buffer = buffer.subarray(recordEnd);
      if (!/WARC-Type:\s*response/i.test(header)) continue;
      const target = /WARC-Target-URI:\s*(\S+)/i.exec(header)?.[1] ?? '';
      const httpEnd = block.indexOf('\r\n\r\n');
      if (httpEnd < 0) continue;
      const http = block.subarray(0, httpEnd).toString('latin1');
      if (!/^HTTP\/\S+\s+200/.test(http) || !/Content-Type:\s*text\/html/i.test(http)) continue;
      if (/Content-Encoding:/i.test(http)) continue;
      const body = block.subarray(httpEnd + 4);
      const html = new TextDecoder('utf-8', { fatal: true });
      let decoded;
      try { decoded = html.decode(body); } catch { continue; }
      if (decoded.length < 512) continue;
      if (accept(target, decoded) === false) { stream.destroy(); return; }
    }
  }
}
