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
    const packed = JSON.parse(runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory]));
    assert.ok(packed[0].files.some(file => file.path.endsWith('.node')), 'tarball contains native binaries');
    tarball = join(directory, packed[0].filename);
  }
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', directory, tarball], directory);
  const installed = JSON.parse(runNpm(['ls', '--all', '--omit=dev', '--json'], directory));
  assert.deepEqual(Object.keys(installed.dependencies?.cheerox?.dependencies ?? {}), [], 'installed package has no transitive npm dependencies');
  for (const mode of ['commonjs', 'module']) {
    const source = mode === 'module'
      ? 'import * as r from "cheerox"; import * as slim from "cheerox/slim"; import * as utils from "cheerox/utils";'
      : 'const r = require("cheerox"), slim = require("cheerox/slim"), utils = require("cheerox/utils");';
    execFileSync(process.execPath, [`--input-type=${mode}`, '-e', source + `
      const assert = ${mode === 'module' ? '(await import("node:assert/strict")).default' : 'require("node:assert/strict")'};
      assert.equal(r.nativeStatus().available, true);
      assert.equal(r.configureWorkers({threads:2}).threads, 2);
      assert.equal(r.load("<h1>Packaged</h1>")("h1").text(), "Packaged");
      assert.ok(r.load("<p>DOM</p>")("p")[0] instanceof r.dom.Element);
      assert.equal(slim.load("<h1>Slim</h1>")("h1").text(), "Slim");
      assert.equal(utils.isHtml("<p>HTML</p>"), true);
      r.extractAll(["<p>Parallel</p>"], { text: "p" }, { threads: 2 }).then(result => {
        assert.deepEqual(result, [{ text: "Parallel" }]);
        assert.equal(r.workerPoolInfo().threads,2);
        assert.ok(r.workerPoolInfo().peakActiveWorkers <= 2);
      });
    `], { cwd: directory, stdio: 'pipe' });
  }
  console.log('Packed npm tarball: ESM, CommonJS, native addon and parallel extraction passed.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
