import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { load } from '../dist/index.mjs';
import * as slim from '../dist/slim.mjs';

const commonjs = createRequire(import.meta.url)('../dist/index.cjs');

test('ESM and CommonJS share moved node and opaque data identities', () => {
  const source = commonjs.load('<p>Source</p>');
  const target = load('<main></main>');
  const held = source('p');
  const node = held[0];
  const callback = () => 'callback';
  const cycle = {}; cycle.self = cycle;
  held.data({ callback, cycle });
  const data = held.data();
  target('main').append(held);
  assert.equal(source('p').length, 0);
  assert.equal(target('p')[0], node);
  assert.equal(target('p').data(), data);
  assert.equal(target('p').data('callback'), callback);
  assert.equal(target('p').data('cycle'), cycle);
  target('p').text('Moved').data('extra', 42);
  assert.equal(held.text(), 'Moved');
  assert.equal(held.data('extra'), 42);
});

test('slim and full entry points share native handles', () => {
  const source = slim.load('<p>Source</p>');
  const target = load('<main></main>');
  const held = source('p');
  const node = held[0];
  target('main').append(held);
  assert.equal(source('p').length, 0);
  assert.equal(target('p')[0], node);
  held.attr('title', 'shared');
  assert.equal(target('p').attr('title'), 'shared');
});

test('two installed copies of the package keep their nodes apart', async () => {
  const { cpSync, mkdtempSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const copy = mkdtempSync(join(tmpdir(), 'cheerox-copy-'));
  try {
    cpSync(join(root, 'dist'), join(copy, 'dist'), { recursive: true });
    for (const name of readdirSync(root).filter((name) => /^cheerox\..+\.node$/.test(name))) cpSync(join(root, name), join(copy, name));
    // A fresh process numbers the first document of each copy alike.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const own = await import(${JSON.stringify(new URL('../dist/index.mjs', import.meta.url).href)});
      const other = await import(${JSON.stringify(pathToFileURL(join(copy, 'dist', 'index.mjs')).href)});
      const $a = own.load('<ul><li>a1</li><li>a2</li></ul><div id="target"></div>');
      const $b = other.load('<p>B text</p><span id="sb">from B</span>');
      const span = $b('#sb');
      $a('#target').append(span);
      assert.equal($a('body').html(), '<ul><li>a1</li><li>a2</li></ul><div id="target"><span id="sb">from B</span></div>');
      assert.equal(span.text(), 'from B');
      assert.deepEqual($a('li').add($b('p')).toArray().map((node) => node.children[0].data), ['a1', 'a2', 'B text']);
    `], { encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
