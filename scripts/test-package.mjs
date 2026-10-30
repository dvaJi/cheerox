import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTarball } from './check-release.mjs';

// Exercise the actual tarball in a consumer directory with spaces in its name.
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cheerox consumer ')));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run this check with npm run test:package');
const runNpm = (args, cwd) => execFileSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  let tarball;
  if (process.argv[2]) {
    tarball = realpathSync(process.argv[2]);
    if (statSync(tarball).isDirectory()) {
      const candidates = readdirSync(tarball).filter(path => path.endsWith('.tgz'));
      assert.equal(candidates.length, 1, 'The release directory must contain exactly one npm tarball');
      tarball = join(tarball, candidates[0]);
    }
    assert.ok([...readTarball(tarball).keys()].some(path => path.endsWith('.node')), 'tarball contains native binaries');
  } else {
    const packedOutput = JSON.parse(runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory]));
    // npm 12 keys the single-entry object by package name; older npm returns an array.
    const packed = Array.isArray(packedOutput) ? packedOutput[0] : packedOutput[Object.keys(packedOutput)[0]];
    assert.ok(packed.files.some(file => file.path.endsWith('.node')), 'tarball contains native binaries');
    tarball = join(directory, packed.filename);
  }
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', directory, tarball], directory);
  const installed = JSON.parse(runNpm(['ls', '--all', '--omit=dev', '--json'], directory));
  assert.deepEqual(Object.keys(installed.dependencies?.["@dvaji/cheerox"]?.dependencies ?? {}), [], 'installed package has no transitive npm dependencies');

  // The root entry: the callable, Cheerio 0.22.0-compatible CommonJS module
  // plus the additive modern extensions; both module systems.
  for (const mode of ['commonjs', 'module']) {
    const source = mode === 'module'
      ? 'import r from "@dvaji/cheerox"; import * as named from "@dvaji/cheerox"; import * as modern from "@dvaji/cheerox/modern";'
      : 'const r = require("@dvaji/cheerox"); const named = r; const modern = require("@dvaji/cheerox/modern");';
    execFileSync(process.execPath, [`--input-type=${mode}`, '-e', source + `
      const assert = ${mode === 'module' ? '(await import("node:assert/strict")).default' : 'require("node:assert/strict")'};
      // Callable legacy surface
      assert.equal(typeof r, "function", "the root export is callable");
      assert.ok(/^\\d+\\.\\d+\\.\\d+$/.test(r.version), "version");
      const $ = r.load("<ul id=\\"fruits\\"><li class=\\"apple\\">Apple</li></ul>");
      assert.equal($(".apple").text(), "Apple");
      assert.equal($.html(), '<ul id="fruits"><li class="apple">Apple</li></ul>');
      assert.equal(named.load("<p>Named</p>")("p").text(), "Named");
      assert.equal(r("<div class=\\"bare\\">bare</div>").attr("class"), "bare");
      assert.ok(r("<div>node</div>")[0].root === null || r("<div>node</div>")[0].root, "root field");
      assert.equal(typeof r.parseHTML, "function");
      assert.equal(r.xml(r.load("<a/>").root()), "<a/>");
      // Modern extras stay available
      assert.equal(modern.nativeStatus().available, true);
      assert.equal(modern.configureWorkers({threads:2}).threads, 2);
      assert.equal(modern.load("<h1>Packaged</h1>")("h1").text(), "Packaged");
      modern.extractAll(["<p>Parallel</p>"], { text: "p" }, { threads: 2 }).then(result => {
        assert.deepEqual(result, [{ text: "Parallel" }]);
      });
    `], { cwd: directory, stdio: 'pipe' });
  }

  // The 1.2.0-style facade and helper entries keep working.
  for (const mode of ['commonjs', 'module']) {
    const source = mode === 'module'
      ? 'import * as slim from "@dvaji/cheerox/slim"; import * as utils from "@dvaji/cheerox/utils"; import * as modern from "@dvaji/cheerox/modern";'
      : 'const slim = require("@dvaji/cheerox/slim"), utils = require("@dvaji/cheerox/utils"), modern = require("@dvaji/cheerox/modern");';
    execFileSync(process.execPath, [`--input-type=${mode}`, '-e', source + `
      const assert = ${mode === 'module' ? '(await import("node:assert/strict")).default' : 'require("node:assert/strict")'};
      assert.equal(slim.load("<h1>Slim</h1>")("h1").text(), "Slim");
      assert.equal(utils.isHtml("<p>HTML</p>"), true);
      assert.ok(modern.load("<p>DOM</p>")("p")[0] instanceof modern.dom.Element);
    `], { cwd: directory, stdio: 'pipe' });
  }
  console.log('Packed npm tarball: callable legacy root, ESM/CJS, modern entry and parallel extraction passed.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
