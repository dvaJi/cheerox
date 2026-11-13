import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));

const platform = process.platform === 'linux'
  ? (process.report?.getReport()?.header?.glibcVersionRuntime ? 'linux-x64-gnu' : 'linux-x64-musl')
  : process.platform === 'win32' ? `win32-${process.arch}-msvc` : `${process.platform}-${process.arch}`;
const binaryName = `cheerox.${platform}.node`;

/**
 * When the platform-specific companion package is installed, the loader must
 * prefer it over the binaries bundled with the main package. Verified in a
 * child process so the loader's module cache starts clean: the stub marks the
 * process global when the loader requires it.
 */
test('the loader prefers the platform companion package over bundled binaries', () => {
  const binary = join(root, binaryName);
  const stubDir = join(root, 'node_modules', '@dvaji', `cheerox-${platform}`);

  let stubbed = false;
  try {
    mkdirSync(stubDir, { recursive: true });
    const binaryRef = JSON.stringify(binary);
    writeFileSync(join(stubDir, 'index.js'), `
globalThis.__cheeroxPlatformStubLoaded = (globalThis.__cheeroxPlatformStubLoaded || 0) + 1;
const real = require(${binaryRef});
if (typeof real.NativeDocument !== 'function') throw new Error('stub could not load the bundled binary');
module.exports = real;
`);
    writeFileSync(join(stubDir, 'package.json'), JSON.stringify({
      name: `@dvaji/cheerox-${platform}`,
      version: '0.0.0-stub',
      main: 'index.js',
    }));
    stubbed = true;

    const probe = `
const modern = require('@dvaji/cheerox/modern');
console.log('STATUS=' + JSON.stringify(modern.nativeStatus()));
console.log('PLATFORM=' + process.platform + '-' + process.arch);
modern.load('<p>x</p>');
console.log('STUB_LOADS=' + (globalThis.__cheeroxPlatformStubLoaded || 0));
console.log('LOAD_OK=1');
`;
    const output = execFileSync(process.execPath, ['-e', probe], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(output, /STUB_LOADS=[1-9]/, 'the platform package was never required');
    assert.match(output, /LOAD_OK=1/, 'loading through the stub failed');
  } finally {
    if (stubbed) rmSync(stubDir, { recursive: true, force: true });
  }
});

test('the loader falls back to bundled binaries when the companion package is absent', () => {
  // Any operation that needs the binding proves the bundled fallback loads.
  const require = createRequire(import.meta.url);
  const cheerox = require('../dist/index.cjs');
  const $ = cheerox.load('<p>fallback</p>');
  assert.equal($('p').text(), 'fallback');
});
