import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapNativeBinding } from './transport.js';
import type { NativeSnapshot } from './snapshot.js';

export interface NativeNodeRecord {
  id: number;
  type: 'root' | 'tag' | 'script' | 'style' | 'text' | 'comment' | 'directive' | 'cdata';
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children: number[];
  parent?: number;
  namespace?: string;
  prefix?: string;
  attribsNamespace?: Record<string, string>;
  attribsPrefix?: Record<string, string>;
  doctypeName?: string;
  publicId?: string;
  systemId?: string;
  'x-name'?: string;
  'x-publicId'?: string;
  'x-systemId'?: string;
  'x-mode'?: 'quirks' | 'limited-quirks' | 'no-quirks';
  [key: string]: any;
}

export interface NativeDocument {
  readonly nodeSpace?: object;
  retainNode?(id: number): void;
  retainNodeData?(id: number, data: object): void;
  adopt?(source: NativeDocument, ids: number[], detach?: boolean): string;
  op(command: string, argsJson: string): string;
  create?(html: string, contextId?: number, optionsJson?: string): number[];
  select(selector: string, contexts?: number[]): number[];
  text(ids: number[]): string;
  innerHtml(id: number): string;
  outerHtml(ids: number[]): string;
  attr(id: number, name: string): string | undefined | null;
  tagName(id: number): string | undefined | null;
  exportTree(): string;
  rootId(): number;
  takePreparedPlans?(): (string | null)[] | null;
  takePreparedSnapshot?(isWanted: boolean): NativeSnapshot | null;
  parserDiagnostics?(): string;
}

export interface NativeStream {
  write(chunk: string): Promise<void>;
  finish(): Promise<NativeDocument>;
  abort(): void;
}

export interface NativeWorkerPoolInfo {
  threads: number;
  activeBatches: number;
  activeWorkers: number;
  peakActiveWorkers: number;
}

export interface NativeQuery {
  key: string;
  selector: string;
  attr?: string;
  all?: boolean;
}

export interface NativeBinding {
  NativeDocument: new (html: string, isDocument?: boolean, optionsJson?: string) => NativeDocument;
  NativeStream?: new (optionsJson: string, isDocument?: boolean, errorBridge?: (request: string) => string) => NativeStream;
  configureWorkerPool?: (threads: number) => void;
  workerPoolInfo?: () => NativeWorkerPoolInfo;
  extractPlanManyAsync?: (html: string[], planJson: string, threads: number, optionsJson?: string) => Promise<string>;
  parseAsync?: (html: string, isDocument?: boolean, optionsJson?: string) => Promise<NativeDocument>;
  parseManyAsync?: (
    html: string[],
    isDocument: boolean,
    threads: number,
    optionsJson?: string,
    plansJson?: string,
  ) => Promise<NativeDocument[]>;
  extractManyAsync?: (
    html: string[],
    queries: NativeQuery[],
    threads: number,
    isDocument?: boolean,
    optionsJson?: string,
  ) => Promise<string>;
}

let cached: NativeBinding | undefined;
let attempted = false;
let bindingError: unknown;

/**
 * The directory of this bundle, shared by the package's CommonJS and ESM
 * entry points and distinct for every installed copy of the package.
 */
export function packageDirectory(): string {
  return typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
}

/** Resolve the native addon bundled with the npm package. */
export function nativeBinding(): NativeBinding | undefined {
  if (attempted) return cached;
  attempted = true;

  // This module is bundled into both CommonJS and ESM entry points. A synthetic
  // absolute filename lets createRequire work in both module formats.
  const moduleDirectory = packageDirectory();
  const require = createRequire(join(moduleDirectory, 'cheerox-loader.cjs'));
  const directories = [moduleDirectory, dirname(moduleDirectory)];
  const libc = process.platform === 'linux'
    ? ((process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })?.header?.glibcVersionRuntime ? 'gnu' : 'musl')
    : undefined;
  const platform = `${process.platform}-${process.arch}${libc ? `-${libc}` : process.platform === 'win32' ? '-msvc' : ''}`;
  const names = [`cheerox.${platform}.node`, 'cheerox.node'];
  const candidates = [...new Set(directories.flatMap((directory) => names.map((name) => join(directory, name))))];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const loaded: NativeBinding = require(candidate);
      if (typeof loaded.NativeDocument === 'function') {
        cached = wrapNativeBinding(loaded);
        return cached;
      }
    } catch (error) {
      bindingError ??= error;
    }
  }
  return undefined;
}

export function requireNative(): NativeBinding {
  const binding = nativeBinding();
  if (binding) return binding;
  throw new Error('Cheerox could not load its Rust native binding. Reinstall cheerox for this platform or run "npm run build:native" from a source checkout.', { cause: bindingError });
}

/** Useful for installation diagnostics and benchmarks that require native code. */
export function nativeStatus(): { available: boolean; error?: string } {
  const available = !!nativeBinding();
  return available ? { available } : { available, error: String(bindingError ?? 'Native binding not found') };
}
