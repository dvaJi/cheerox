import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { isBuiltin } from 'node:module';

test('the npm package has zero runtime dependencies', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(manifest.optionalDependencies ?? {}), []);
  assert.deepEqual(manifest.bundledDependencies ?? [], []);
});

test('built JavaScript and declarations import only Node builtins or local files', () => {
  const directory = new URL('../dist/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => /\.(?:[cm]?js|[cm]?ts)$/.test(name))) {
    const contents = readFileSync(new URL(name, directory), 'utf8');
    for (const match of contents.matchAll(/(?:\bfrom\s*|\brequire\s*\(|\bimport\s*\()\s*['"]([^'"]+)['"]/g)) {
      assert.ok(match[1].startsWith('.') || isBuiltin(match[1]), `${name} imports external dependency ${match[1]}`);
    }
  }
});
