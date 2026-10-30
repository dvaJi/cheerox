import { Readable, Writable } from 'node:stream';
import { request as requestHTTP } from 'node:http';
import { request as requestHTTPS } from 'node:https';
import { stringify as stringifyQuery } from 'node:querystring';
import type { EventEmitter } from 'node:events';
import { MIMEType } from 'node:util';
import { createAPI, flattenOptions, load } from './index.js';
import { requireNative, type NativeStream } from './native.js';
import { createDiagnosticSession, createTokenizerSession, createTreeAdapterSession, deliverParseErrors, parserOptions } from './hooks.js';
import { routeDocument } from './router.js';
import type { CheerioAPI, CheerioOptions, CheerioRequestOptions, DecodeStreamOptions, EncodingOptions } from './types.js';

export type LoadCallback = (error: Error | null | undefined, document: CheerioAPI) => void;

function encodingLabel(label: string | null | undefined): string | undefined {
  if (!label) return undefined;
  if (label.trim().toLowerCase() === 'x-user-defined') return 'x-user-defined';
  try { return new TextDecoder(label.trim()).encoding; } catch { return undefined; }
}

/** WHATWG decoding with BOM, transport headers, and the HTML meta prescan. */
function sniffEncoding(buffer: Uint8Array, options: EncodingOptions = {}): string {
  let label: string | undefined;
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) label = 'utf-8';
  else if (buffer[0] === 0xff && buffer[1] === 0xfe) label = 'utf-16le';
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) label = 'utf-16be';
  label ??= encodingLabel((options as EncodingOptions & { userEncoding?: string }).userEncoding);
  label ??= encodingLabel(options.transportLayerEncodingLabel);
  if (!label && buffer[0] === 0 && buffer[1] === 0x3c && buffer[2] === 0 && buffer[3] === 0x3f && buffer[4] === 0 && buffer[5] === 0x78) label = 'utf-16be';
  if (!label && buffer[0] === 0x3c && buffer[1] === 0 && buffer[2] === 0x3f && buffer[3] === 0 && buffer[4] === 0x78 && buffer[5] === 0) label = 'utf-16le';
  if (!label) {
    const prefix = Buffer.from(buffer.subarray(0, options.maxBytes ?? 1024)).toString('latin1').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
    for (const token of prefix.matchAll(/<meta\b([^>]*)>/gi)) {
      const attributes: Record<string, string> = {};
      for (const attribute of token[1].matchAll(/([^\s=/'">]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
        const key = attribute[1].toLowerCase();
        if (!(key in attributes)) attributes[key] = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      }
      const declared = attributes.charset ?? (attributes['http-equiv']?.toLowerCase() === 'content-type'
        ? /\bcharset\s*=\s*["']?([^\s;"']+)/i.exec(attributes.content ?? '')?.[1] : undefined);
      label = encodingLabel(declared);
      if (label) {
        if (label === 'utf-16le' || label === 'utf-16be') label = 'utf-8';
        if (label === 'x-user-defined') label = 'windows-1252';
        break;
      }
    }
    if (!label) {
      const declaration = /<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(prefix);
      label = encodingLabel(declaration?.[1]);
      if (label === 'utf-16le' || label === 'utf-16be') label = 'utf-8';
    }
  }
  label ??= encodingLabel(options.defaultEncoding) ?? 'windows-1252';
  return label;
}

export function decodeBuffer(buffer: Uint8Array, options: EncodingOptions = {}): string {
  const label = sniffEncoding(buffer, options);
  if (label === 'x-user-defined') {
    let decoded = '';
    for (const byte of buffer) decoded += String.fromCharCode(byte < 0x80 ? byte : 0xf700 + byte);
    return decoded;
  }
  return new TextDecoder(label).decode(buffer);
}

function decodedInput(buffer: Uint8Array, options: DecodeStreamOptions): [string, CheerioOptions] {
  const { encoding, ...parserOptions } = options;
  const xml = !!(options.xmlMode || options.xml);
  return [decodeBuffer(buffer, { defaultEncoding: xml ? 'utf-8' : 'windows-1252', ...encoding }), parserOptions];
}

export function loadBuffer(buffer: Buffer | Uint8Array, options: DecodeStreamOptions = {}): CheerioAPI {
  return load(...decodedInput(buffer, options));
}

function completion(callback: LoadCallback): (error?: Error | null, document?: CheerioAPI) => void {
  let completed = false;
  return (error, document) => {
    if (completed) return;
    completed = true;
    callback(error, document as CheerioAPI);
  };
}

function requestHeaders(input: NonNullable<CheerioRequestOptions['requestOptions']>['headers']): Headers {
  if (!input) return new Headers();
  if (input instanceof Headers) return new Headers(input);
  const headers = new Headers();
  if (Array.isArray(input)) {
    if (input.length % 2) throw new TypeError('HTTP header arrays must contain name/value pairs');
    for (let index = 0; index < input.length; index += 2) headers.append(input[index], input[index + 1]);
  } else {
    const entries: Iterable<[string, string | string[] | undefined]> = Symbol.iterator in input
      ? input as Iterable<[string, string | string[] | undefined]> : Object.entries(input);
    for (const [name, value] of entries) {
      if (value == null) continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
    }
  }
  return headers;
}

interface HTTPResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  rawHeaders?: Record<string, string | string[] | undefined>;
}

/** Node transport exposes informational responses and leaves wire headers alone. */
async function requestDocument(url: URL, method: string, headers: Headers, body: NonNullable<CheerioRequestOptions['requestOptions']>['body'], options: NonNullable<CheerioRequestOptions['requestOptions']>, signal: AbortSignal): Promise<HTTPResponse> {
  if (options.typeOfService != null && (!Number.isInteger(options.typeOfService) || options.typeOfService < 0 || options.typeOfService > 255)) {
    throw Object.assign(new Error('typeOfService must be an integer between 0 and 255'), { name: 'InvalidArgumentError', code: 'UND_ERR_INVALID_ARG' });
  }
  let payload: string | Uint8Array | Readable | ReadableStream<Uint8Array> | null | undefined = body as string | Uint8Array | Readable | null | undefined;
  if (body && typeof body === 'object' && !(body instanceof Uint8Array) && !(body instanceof Readable)) {
    // Request supplies Node's built-in multipart encoder for either Node or
    // Undici FormData without requiring the Undici package at runtime.
    let form: FormData;
    if (body instanceof FormData) form = body;
    else {
      form = new FormData();
      for (const [name, value] of body as import('./types.js').FormDataLike) {
        if (typeof value === 'string') form.append(name, value);
        else if ('name' in value && typeof value.name === 'string') form.append(name, value as Blob, value.name);
        else form.append(name, value as Blob);
      }
    }
    const encoded = new Request(url, { method: 'POST', body: form });
    // Node 20's encoder omits the final CRLF used by Undici 7. Keep the
    // request streaming while normalizing that suffix across Node versions.
    payload = Readable.from((async function* () {
      let previous = -1;
      let last = -1;
      for await (const chunk of Readable.fromWeb(encoded.body! as import('node:stream/web').ReadableStream<Uint8Array>)) {
        const bytes = chunk as Buffer;
        if (bytes.length >= 2) previous = bytes[bytes.length - 2];
        else if (bytes.length === 1) previous = last;
        if (bytes.length) last = bytes[bytes.length - 1];
        yield bytes;
      }
      if (previous !== 13 || last !== 10) yield Buffer.from('\r\n');
    })());
    if (!requestHeaders(options.headers).has('content-type')) headers.set('content-type', encoded.headers.get('content-type')!);
  }
  if (payload != null && !(payload instanceof Readable) && !(typeof payload === 'object' && 'getReader' in payload) && !headers.has('content-length') && !headers.has('transfer-encoding')) {
    headers.set('content-length', String(typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength));
  }
  const declaredLength = headers.has('content-length') ? Number(headers.get('content-length')) : undefined;
  const lengthError = () => Object.assign(new Error('Request body length does not match content-length header'), { name: 'RequestContentLengthMismatchError', code: 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH' });
  const knownLength = typeof payload === 'string' ? Buffer.byteLength(payload) : payload instanceof Uint8Array ? payload.byteLength : undefined;
  if (declaredLength != null && knownLength != null && declaredLength !== knownLength) throw lengthError();
  if (options.reset === true && !headers.has('connection')) headers.set('connection', 'close');
  return new Promise<HTTPResponse>((resolve, reject) => {
    let informationalError: Error | undefined;
    const request = (url.protocol === 'https:' ? requestHTTPS : requestHTTP)(url, {
      method, headers: Object.fromEntries(headers), signal,
      ...(typeof options.highWaterMark === 'number' ? { highWaterMark: options.highWaterMark } : {}),
    }, response => {
      if (informationalError) { response.destroy(); return; }
      const rawHeaders: Record<string, string | string[]> = {};
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const name = response.rawHeaders[index].toLowerCase();
        const value = response.rawHeaders[index + 1];
        if (!Object.hasOwn(rawHeaders, name)) Object.defineProperty(rawHeaders, name, { value, enumerable: true, writable: true, configurable: true });
        else rawHeaders[name] = [...(Array.isArray(rawHeaders[name]) ? rawHeaders[name] : [rawHeaders[name]]) as string[], value];
      }
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(rawHeaders)) {
        if (value == null) continue;
        for (const item of Array.isArray(value) ? name === 'content-type' ? value.slice(0, 1) : value : [value]) responseHeaders.append(name, item);
      }
      const status = response.statusCode ?? 0;
      resolve({ status, ok: status >= 200 && status < 300, headers: responseHeaders, rawHeaders, body: Readable.toWeb(response) as ReadableStream<Uint8Array> });
    });
    request.once('error', error => reject(signal.aborted ? signal.reason : error));
    request.on('information', information => {
      try { options.onInfo?.({ statusCode: information.statusCode, headers: information.headers as Record<string, string | string[]> }); }
      catch (error) { informationalError = error as Error; reject(error); request.destroy(error as Error); }
    });
    request.once('socket', socket => {
      const transport = socket as typeof socket & { setTypeOfService?: (value?: number) => void };
      try {
        if (transport.setTypeOfService && options.typeOfService != null) transport.setTypeOfService(options.typeOfService);
      } catch (error) { request.destroy(error as Error); return; }
      if (socket.connecting) {
        const timer = setTimeout(() => request.destroy(Object.assign(new Error('Connect Timeout Error'), { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' })), 10000);
        timer.unref();
        socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(timer));
        request.once('close', () => clearTimeout(timer));
      }
    });
    if (payload instanceof Readable || payload && typeof payload === 'object' && 'getReader' in payload) {
      const source = payload instanceof Readable ? payload : Readable.fromWeb(payload as unknown as import('node:stream/web').ReadableStream<Uint8Array>);
      if (declaredLength != null) {
        let sent = 0;
        source.on('data', (chunk: Buffer | string) => {
          sent += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
          if (sent > declaredLength) { request.destroy(lengthError()); source.destroy(); }
        });
        source.once('end', () => { if (sent !== declaredLength) request.destroy(lengthError()); });
      }
      source.once('error', error => request.destroy(error));
      request.once('close', () => { if (!source.destroyed) source.destroy(); });
      source.pipe(request);
    } else request.end(payload);
  });
}

/** A Node writable that feeds the native parser with bounded backpressure. */
export function stringStream(options: CheerioOptions, callback: LoadCallback): Writable {
  const complete = completion(callback);
  const opts = flattenOptions(options);
  const xml = !!opts._useHtmlParser2;
  const binding = requireNative();
  let native: NativeStream | undefined;
  let writeNative: (chunk: string) => Promise<void>;
  let finishNative: () => Promise<CheerioAPI>;
  let abortNative: () => void;
  let carry = '';
  if (opts._useHtmlParser2 && opts.Tokenizer) {
    const session = createTokenizerSession(opts);
    // Arbitrary user tokenizers can emit offsets for any earlier input. Retain
    // their source until end rather than changing their callback contract.
    const chunks: string[] = [];
    writeNative = async (chunk) => { chunks.push(chunk); session.write(chunk); };
    finishNative = async () => {
      const document = new binding.NativeDocument(chunks.join(''), true, JSON.stringify(session.end()));
      chunks.length = 0;
      return createAPI(routeDocument(document, opts), opts);
    };
    abortNative = () => { chunks.length = 0; };
  } else if (!opts._useHtmlParser2 && opts.treeAdapter) {
    const session = createTreeAdapterSession(opts, true);
    writeNative = (chunk) => session.write(chunk);
    finishNative = async () => createAPI(await session.end(), opts);
    abortNative = () => session.abort();
  } else if (!opts._useHtmlParser2 && opts.onParseError) {
    const session = createDiagnosticSession(opts, true);
    writeNative = (chunk) => session.write(chunk);
    finishNative = async () => createAPI(await session.end(), opts);
    abortNative = () => session.abort();
  } else {
    if (!binding.NativeStream) throw new Error('This native build does not support incremental parsing');
    native = new binding.NativeStream(JSON.stringify(parserOptions('', opts)), true);
    writeNative = (chunk) => native!.write(chunk);
    finishNative = async () => {
      const document = await native!.finish();
      deliverParseErrors(document, opts);
      return createAPI(routeDocument(document, opts), opts);
    };
    abortNative = () => native!.abort();
  }
  const stream = new Writable({
    decodeStrings: false,
    write(chunk, _encoding, done) {
      if (typeof chunk !== 'string') throw new TypeError(xml ? 'Expected a string' : 'Parser can work only with string streams.');
      if (opts._useHtmlParser2 && opts.Tokenizer) { writeNative(chunk).then(() => done(), (error: Error) => done(error)); return; }
      let text = carry + chunk;
      carry = '';
      const last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) { carry = text.slice(-1); text = text.slice(0, -1); }
      if (!text) { done(); return; }
      writeNative(text).then(() => done(), (error: Error) => done(error));
    },
    final(done) {
      (async () => {
        if (carry) await writeNative(carry);
        return finishNative();
      })().then((document) => {
        complete(null, document);
        done();
      }, (error: Error) => done(error));
    },
    destroy(error, done) { abortNative(); done(error); },
  });
  stream.on('error', (error) => complete(error));
  return stream;
}

/** Sniff a bounded prefix, then decode and parse each chunk as it arrives. */
export function decodeStream(options: DecodeStreamOptions, callback: LoadCallback): Writable {
  const complete = completion(callback);
  const { encoding = {}, ...parserOptions } = options ?? {};
  const opts = flattenOptions(parserOptions);
  const decoderOptions = { defaultEncoding: opts.xmlMode ? 'utf-8' : 'windows-1252', ...encoding };
  const maxBytes = decoderOptions.maxBytes ?? 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('encoding.maxBytes must be a non-negative integer');
  const prefixLimit = Math.max(6, maxBytes);
  const prefix: Buffer[] = [];
  let prefixLength = 0;
  let decoder: TextDecoder | undefined;
  let userDefined = false;
  let started = false;
  const parser = stringStream(opts, (error, document) => complete(error, document));
  let downstreamError: Error | undefined;
  parser.on('error', (error) => { downstreamError = error; stream.destroy(error); });
  const writeText = (text: string): Promise<void> => new Promise((resolve, reject) => {
    if (downstreamError) { reject(downstreamError); return; }
    if (!text) { resolve(); return; }
    parser.write(text, (error?: Error | null) => error ? reject(error) : resolve());
  });
  const decode = (bytes: Uint8Array, final = false): string => {
    if (userDefined) {
      let text = '';
      for (const byte of bytes) text += String.fromCharCode(byte < 0x80 ? byte : 0xf700 + byte);
      return text;
    }
    return decoder!.decode(bytes, { stream: !final });
  };
  const start = async (): Promise<void> => {
    const bytes = Buffer.concat(prefix, prefixLength);
    const label = sniffEncoding(bytes, decoderOptions);
    userDefined = label === 'x-user-defined';
    if (!userDefined) decoder = new TextDecoder(label);
    started = true;
    prefix.length = 0;
    await writeText(decode(bytes));
  };
  const accept = async (bytes: Buffer): Promise<void> => {
    if (!started) {
      const count = Math.min(prefixLimit - prefixLength, bytes.length);
      if (count) { prefix.push(Buffer.from(bytes.subarray(0, count))); prefixLength += count; }
      bytes = bytes.subarray(count);
      const declaredEncoding = encodingLabel(decoderOptions.userEncoding) || encodingLabel(decoderOptions.transportLayerEncodingLabel);
      if (prefixLength >= prefixLimit || declaredEncoding && prefixLength >= 3) await start();
    }
    if (started && bytes.length) await writeText(decode(bytes));
  };
  const stream = new Writable({
    write(chunk: Buffer | string, encoding, done) {
      accept(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)).then(() => done(), (error: Error) => done(error));
    },
    final(done) {
      (async () => {
        if (!started) await start();
        await writeText(decode(new Uint8Array(), true));
        await new Promise<void>((resolve, reject) => {
          parser.once('error', reject);
          parser.end(() => { parser.removeListener('error', reject); resolve(); });
        });
      })().then(() => done(), (error: Error) => done(error));
    },
    destroy(error, done) { parser.destroy(error ?? undefined); done(error); },
  });
  stream.on('error', (error) => complete(error));
  return stream;
}

/** Load HTML or XML with bounded redirects through Node's built-in transport. */
export async function fromURL(url: string | URL, options: CheerioRequestOptions = {}): Promise<CheerioAPI> {
  const signal = options.requestOptions?.signal;
  if (!signal) return loadURL(url, options);
  if (typeof signal !== 'object' && typeof signal !== 'function') throw new TypeError('signal must be an AbortSignal or EventEmitter');
  if ('addEventListener' in signal) return loadURL(url, options);
  if (!('once' in signal) || !('removeListener' in signal)) throw new TypeError('signal must be an AbortSignal or EventEmitter');
  const emitter = signal as EventEmitter;
  const controller = new AbortController();
  const abort = () => controller.abort();
  emitter.once('abort', abort);
  try { return await loadURL(url, { ...options, requestOptions: { ...options.requestOptions, signal: controller.signal } }); }
  finally { emitter.removeListener('abort', abort); }
}

async function loadURL(url: string | URL, options: CheerioRequestOptions): Promise<CheerioAPI> {
  const { requestOptions = {}, encoding, ...parserOptions } = options;
  const maxRedirects = requestOptions.maxRedirections ?? 5;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) throw new RangeError('maxRedirections must be a non-negative integer');
  const headers = requestHeaders(requestOptions.headers);
  if (!Object.hasOwn(requestOptions, 'headers')) headers.set('accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
  let current = new URL(url);
  if (requestOptions.query) {
    if (current.search || current.hash) throw new TypeError('URL must not contain a query or fragment when requestOptions.query is supplied');
    current.search = stringifyQuery(requestOptions.query);
  }
  let method = requestOptions.method ?? 'GET';
  let body = requestOptions.body;
  let response: HTTPResponse;
  const controller = new AbortController();
  const signal = requestOptions.signal ? AbortSignal.any([requestOptions.signal as AbortSignal, controller.signal]) : controller.signal;
  const timeoutError = (kind: 'Headers' | 'Body') => Object.assign(new Error(`${kind} Timeout Error`), {
    name: `${kind}TimeoutError`, code: kind === 'Headers' ? 'UND_ERR_HEADERS_TIMEOUT' : 'UND_ERR_BODY_TIMEOUT',
  });
  for (const timeout of [requestOptions.headersTimeout, requestOptions.bodyTimeout]) {
    if (timeout != null && (!Number.isFinite(timeout) || timeout < 0)) throw new RangeError('HTTP timeouts must be non-negative finite numbers');
  }
  const suppliedDispatcher = requestOptions.dispatcher as { dispatch?: (options: unknown, handler: unknown) => boolean } | undefined;
  if (suppliedDispatcher && typeof suppliedDispatcher.dispatch !== 'function') throw new TypeError('requestOptions.dispatcher must implement dispatch');
  const dispatcher = suppliedDispatcher && {
    dispatch(dispatchOptions: Record<string, unknown>, handler: unknown) {
      // Keep fetch's URL/body/header encoding and forward the remaining Undici
      // transport options to the caller's dispatcher without an npm dependency.
      const { dispatcher: _dispatcher, throwOnError: _throwOnError, maxRedirections: _maxRedirections, query: _query, ...transport } = requestOptions;
      return suppliedDispatcher.dispatch!({ ...transport, ...dispatchOptions }, handler);
    },
  };
  for (let redirects = 0; ; redirects += 1) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const headersTimeout = requestOptions.headersTimeout ?? 300000;
    if (headersTimeout) { timer = setTimeout(() => controller.abort(timeoutError('Headers')), headersTimeout); timer.unref(); }
    try {
      if (dispatcher) {
        const init: RequestInit & { dispatcher?: unknown; duplex?: 'half' } = { method, headers, body: body as BodyInit | undefined, redirect: 'manual', signal, dispatcher };
        if (body != null && typeof body !== 'string') init.duplex = 'half';
        response = await fetch(current, init);
      } else response = await requestDocument(current, method, headers, body, requestOptions, signal);
    } catch (error) {
      throw signal.aborted ? signal.reason : error;
    } finally { if (timer) clearTimeout(timer); }
    const location = response.headers.get('location');
    if (![300, 301, 302, 303, 307, 308].includes(response.status) || !location) break;
    const rewriteToGet = response.status === 303 && method.toUpperCase() !== 'HEAD' || (response.status === 301 || response.status === 302) && method.toUpperCase() === 'POST';
    if (body instanceof Readable && body.readableDidRead && !rewriteToGet) break;
    await response.body?.cancel();
    if (redirects >= maxRedirects) throw new Error('max redirects reached');
    const next = new URL(location, current);
    headers.delete('host');
    if (response.status === 303) for (const name of [...headers.keys()]) if (name.startsWith('content-')) headers.delete(name);
    if (next.origin !== current.origin) {
      headers.delete('authorization');
      headers.delete('cookie');
      headers.delete('proxy-authorization');
    }
    if (rewriteToGet) {
      method = 'GET';
      body = undefined;
      headers.delete('content-length');
      headers.delete('content-type');
    }
    current = next;
  }
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error('Response Error') as Error & { statusCode: number; code: string; headers: Record<string, string | string[] | undefined> };
    error.name = 'ResponseError';
    error.statusCode = response.status;
    error.code = 'UND_ERR_RESPONSE';
    error.headers = response.rawHeaders ?? Object.fromEntries(response.headers);
    throw error;
  }
  const contentType = response.headers.get('content-type') ?? 'text/html';
  let parsedType: MIMEType;
  try { parsedType = new MIMEType(contentType); }
  catch {
    await response.body?.cancel();
    throw new Error(`Could not parse MIME type string "${contentType}"`);
  }
  const mime = parsedType.essence;
  const xml = (parsedType.type === 'application' || parsedType.type === 'text') && parsedType.subtype === 'xml' || parsedType.subtype.endsWith('+xml');
  if (mime !== 'text/html' && !xml) {
    await response.body?.cancel();
    throw new RangeError(`The content-type "${mime}" is neither HTML nor XML.`);
  }
  const charset = parsedType.params.get('charset') ?? undefined;
  if (encoding) encoding.transportLayerEncodingLabel = charset;
  const streamOptions: DecodeStreamOptions = {
    xmlMode: xml,
    baseURI: current,
    ...parserOptions,
    encoding: { ...encoding, transportLayerEncodingLabel: charset },
  };
  return new Promise<CheerioAPI>((resolve, reject) => {
    const parser = decodeStream(streamOptions, (error, document) => error ? reject(error) : resolve(document));
    const reader = response.body?.getReader();
    parser.once('error', (error) => { controller.abort(error); void reader?.cancel(error).catch(() => {}); });
    (async () => {
      let received = 0;
      const maxResponseSize = requestOptions.maxResponseSize;
      if (maxResponseSize != null && (typeof maxResponseSize !== 'number' || !Number.isSafeInteger(maxResponseSize) || maxResponseSize < -1)) throw new RangeError('maxResponseSize must be -1 or a non-negative integer');
      while (reader) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const bodyTimeout = requestOptions.bodyTimeout ?? 300000;
        if (bodyTimeout) { timer = setTimeout(() => controller.abort(timeoutError('Body')), bodyTimeout); timer.unref(); }
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); }
        catch (error) { throw controller.signal.aborted ? controller.signal.reason : error; }
        finally { if (timer) clearTimeout(timer); }
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (typeof maxResponseSize === 'number' && maxResponseSize >= 0 && received > maxResponseSize) {
          throw Object.assign(new Error('Response content exceeded maxResponseSize'), { name: 'ResponseExceededMaxSizeError', code: 'UND_ERR_RES_EXCEEDED_MAX_SIZE' });
        }
        await new Promise<void>((resolve, reject) => parser.write(Buffer.from(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength), (error?: Error | null) => error ? reject(error) : resolve()));
      }
      parser.end();
    })().catch((error: Error) => { parser.destroy(error); reject(error); });
  });
}
