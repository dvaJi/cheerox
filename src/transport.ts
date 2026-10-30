import { decodeJson, decodeString, encodeJson, encodeOptions, encodeString } from './codec.js';
import type { NativeBinding, NativeDocument } from './native.js';

interface TransportRegistry {
  userErrors: WeakSet<object>;
}
const registryKey = Symbol.for('cheerox.native-transport.v2');
const globals = globalThis as typeof globalThis & { [key: symbol]: TransportRegistry | undefined };
const registry = globals[registryKey] ??= { userErrors: new WeakSet() };
const transportedKey = Symbol.for('cheerox.native-transport.prototype');

const jsonMethods = new Set(['op', 'node', 'exportTree', 'parserDiagnostics', 'adopt']);
/** String arguments each document method takes, by position, and how to encode them. */
const argumentEncoders: Record<string, (args: any[]) => void> = {
  op: (args) => { args[1] = encodeJson(args[1]); },
  create: (args) => { args[0] = encodeString(args[0]); if (typeof args[2] === 'string') args[2] = encodeOptions(args[2]); },
  select: (args) => { args[0] = encodeString(args[0]); },
  matches: (args) => { args[0] = encodeString(args[0]); },
  attr: (args) => { args[1] = encodeString(args[1]); },
  setAttribute: (args) => { args[1] = encodeString(args[1]); if (typeof args[2] === 'string') args[2] = encodeString(args[2]); },
  render: (args) => { if (typeof args[1] === 'string') args[1] = encodeJson(args[1]); },
};

/** Keep the codec at the private addon boundary, including callback RPC. */
export function wrapNativeBinding(binding: NativeBinding): NativeBinding {
  const raw = binding as NativeBinding & Record<string, any>;
  const { userErrors } = registry;
  const restoreError = (error: unknown): never => {
    if (error instanceof Error && !userErrors.has(error)) {
      const message = decodeString(error.message);
      if (message !== error.message) {
        const stack = error.stack;
        error.message = message;
        if (stack) error.stack = decodeString(stack);
      }
    }
    throw error;
  };
  const invoke = <T>(call: () => T): T => {
    try {
      const result = call();
      return result instanceof Promise ? result.catch(restoreError) as T : result;
    } catch (error) { return restoreError(error); }
  };
  const wrapBridge = (bridge: (request: string) => string) => (request: string): string => {
    try { return encodeJson(bridge(decodeJson(request))); }
    catch (error) {
      if (error !== null && (typeof error === 'object' || typeof error === 'function')) userErrors.add(error);
      throw error;
    }
  };
  // Wrapping the class's methods once, rather than each document in a proxy,
  // keeps native calls free of per-document and per-call allocations.
  const transportMethod = (name: string, method: (...args: any[]) => unknown) => {
    const encodeArguments = argumentEncoders[name];
    const decode = jsonMethods.has(name) ? decodeJson : decodeString;
    const isOperation = name === 'op';
    return function transported(this: NativeDocument, ...args: any[]): unknown {
      try {
        if (encodeArguments) encodeArguments(args);
        const result = method.apply(this, args);
        if (typeof result !== 'string') return result;
        if (isOperation && args[0] === 'serialize' && result.startsWith('{')) {
          const error = JSON.parse(result).__nativeError;
          if (error?.name === 'URIError') throw new URIError(error.message);
        }
        return decode(result);
      } catch (error) { return restoreError(error); }
    };
  };
  const prototype = raw.NativeDocument.prototype as Record<PropertyKey, unknown>;
  if (!Object.hasOwn(prototype, transportedKey)) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const method = prototype[name];
      if (name !== 'constructor' && typeof method === 'function') prototype[name] = transportMethod(name, method as (...args: any[]) => unknown);
    }
    Object.defineProperty(prototype, transportedKey, { value: true });
  }
  const wrapStream = (stream: any) => {
    let carry = '';
    return {
      async write(chunk: string) {
        let source = carry + chunk;
        carry = '';
        const last = source.charCodeAt(source.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) { carry = source.slice(-1); source = source.slice(0, -1); }
        if (source) await invoke(() => stream.write(encodeString(source)));
      },
      async finish() {
        if (carry) { const final = carry; carry = ''; await invoke(() => stream.write(encodeString(final))); }
        return invoke(() => stream.finish());
      },
      abort() { carry = ''; return invoke(() => stream.abort()); },
    };
  };
  const wrapConstructor = (Constructor: any, argumentsFor: (args: any[]) => any[], wrap: (value: any) => any) => new Proxy(Constructor, {
    construct(target, args) { return wrap(invoke(() => Reflect.construct(target, argumentsFor(args)))); },
  });
  const wrapped: NativeBinding & Record<string, any> = { ...raw };
  const Document = raw.NativeDocument;
  wrapped.NativeDocument = function NativeDocument(html: string, isDocument?: boolean, options?: string) {
    try { return new Document(encodeString(html), isDocument, encodeOptions(options)); }
    catch (error) { return restoreError(error); }
  } as unknown as NativeBinding['NativeDocument'];
  if (raw.NativeStream) wrapped.NativeStream = wrapConstructor(raw.NativeStream, ([options, isDocument, bridge]) => [encodeOptions(options), isDocument, bridge && wrapBridge(bridge)], wrapStream);
  if (raw.NativeHookStream) wrapped.NativeHookStream = wrapConstructor(raw.NativeHookStream, ([isDocument, options, bridge]) => [isDocument, encodeOptions(options), wrapBridge(bridge)], wrapStream);
  if (raw.parseWithTreeAdapter) wrapped.parseWithTreeAdapter = (source: string, isDocument: boolean, options: string, bridge: (request: string) => string) => invoke(() => raw.parseWithTreeAdapter(encodeString(source), isDocument, encodeOptions(options), wrapBridge(bridge)));
  if (raw.parseAsync) wrapped.parseAsync = (source, isDocument, options) => invoke(() => raw.parseAsync!(encodeString(source), isDocument, encodeOptions(options)));
  if (raw.parseManyAsync) wrapped.parseManyAsync = (sources, isDocument, threads, options, plans) => invoke(() => raw.parseManyAsync!(sources.map(encodeString), isDocument, threads, encodeOptions(options), plans === undefined ? undefined : encodeJson(plans)));
  if (raw.extractPlanManyAsync) wrapped.extractPlanManyAsync = async (sources, plan, threads, options) => decodeJson(await invoke(() => raw.extractPlanManyAsync!(sources.map(encodeString), encodeJson(plan), threads, encodeOptions(options))));
  if (raw.extractManyAsync) wrapped.extractManyAsync = async (sources, queries, threads, isDocument, options) => decodeJson(await invoke(() => raw.extractManyAsync!(sources.map(encodeString), queries.map((query) => ({ ...query, key: encodeString(query.key), selector: encodeString(query.selector), ...(query.attr === undefined ? {} : { attr: encodeString(query.attr) }) })), threads, isDocument, encodeOptions(options))));
  return wrapped;
}
