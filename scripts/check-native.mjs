import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { nativeTargets, validateNativeBinary } from './check-release.mjs';
import { nativeStatus } from '../dist/index.mjs';

const status = nativeStatus();
assert.ok(status.available, `Build the native addon before packaging: ${status.error}`);
if (process.argv.includes('--all')) {
  const files = new Set(readdirSync(new URL('../', import.meta.url)));
  for (const target of nativeTargets) {
    assert.ok(files.has(`cheerox.${target}.node`), `Release is missing the ${target} native binary`);
  }
}

for (const name of readdirSync(new URL('../', import.meta.url)).filter(name => /^cheerox\..+\.node$/.test(name))) validateNativeBinary(name, readFileSync(new URL(`../${name}`, import.meta.url)));
