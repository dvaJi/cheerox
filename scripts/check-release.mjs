import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const nativeTargets = ['darwin-x64', 'darwin-arm64', 'linux-x64-gnu', 'linux-arm64-gnu', 'linux-x64-musl', 'linux-arm64-musl', 'win32-x64-msvc', 'win32-arm64-msvc'];
const requiredFiles = ['package.json', 'LICENSE', 'README.md', 'CONTRIBUTING.md', 'RELEASING.md', 'THIRD_PARTY_NOTICES.md', 'Cargo.toml', 'Cargo.lock', 'build.rs', 'native/src/lib.rs', 'native/vendor/README.md', 'native/vendor/html5ever-0.35.0/Cargo.toml', 'native/vendor/html5ever-0.35.0/src/lib.rs', 'native/vendor/html5ever-0.35.0/LICENSE-MIT', 'native/vendor/html5ever-0.35.0/LICENSE-APACHE', 'native/vendor/markup5ever-0.35.0/Cargo.toml', 'native/vendor/markup5ever-0.35.0/lib.rs', 'native/vendor/markup5ever-0.35.0/LICENSE-MIT', 'native/vendor/markup5ever-0.35.0/LICENSE-APACHE', 'src/index.ts', 'tsconfig.json', 'tsup.config.ts', 'scripts/check-native.mjs', 'scripts/check-release.mjs', 'scripts/fix-declarations.mjs', 'scripts/generate-notices.mjs', 'scripts/notices/sources.json', 'scripts/notices/runtime.json', 'scripts/notices/cheerio-MIT.txt', 'dist/index.cjs', 'dist/index.mjs', 'dist/index.d.ts', 'dist/index.d.mts', 'dist/slim.cjs', 'dist/slim.mjs', 'dist/utils.cjs', 'dist/utils.mjs'];
const root = fileURLToPath(new URL('../', import.meta.url));

export function validateVersion(version, distTag = 'latest') {
  assert.equal(typeof version, 'string', 'A release version is required');
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*))?$/, 'Use an exact semantic version without a v prefix or build metadata');
  const prerelease = version.split('-').slice(1).join('-');
  for (const identifier of prerelease.split('.')) assert.ok(!/^0\d+$/.test(identifier), 'Numeric prerelease identifiers cannot have leading zeroes');
  assert.ok(distTag === 'latest' || distTag === 'next', 'The npm dist-tag must be latest or next');
  assert.ok(!prerelease || distTag !== 'latest', 'Prereleases must use the next npm dist-tag');
  return `v${version}`;
}

export function validateMetadata(metadata, cargo) {
  assert.equal(metadata.name, 'cheerox');
  validateVersion(metadata.version, metadata.version.includes('-') ? 'next' : 'latest');
  assert.equal(metadata.license, 'MIT');
  assert.notEqual(metadata.private, true, 'The release package cannot be private');
  assert.equal(metadata.author, 'Francisco Pizarro');
  assert.equal(metadata.repository?.url, 'git+https://github.com/dvaJi/cheerox.git');
  assert.equal(metadata.engines?.node, '>=20.19.0');
  assert.equal(metadata.publishConfig?.access, 'public');
  assert.equal(metadata.publishConfig?.registry, 'https://registry.npmjs.org/');
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) assert.deepEqual(Object.keys(metadata[key] ?? {}), [], `${key} must remain empty`);
  for (const key of ['bundledDependencies', 'bundleDependencies']) assert.ok(!metadata[key] || Array.isArray(metadata[key]) && !metadata[key].length, `${key} must remain empty`);
  for (const lifecycle of ['preinstall', 'install', 'postinstall']) assert.equal(metadata.scripts?.[lifecycle], undefined, `The package must not require an ${lifecycle} hook`);
  assert.equal(cargo.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)?.[1], metadata.version, 'Cargo and npm versions must match');
}

/** Read ELF version requirements from SHT_GNU_verneed, rather than strings in code/data. */
export function elfRequirements(data) {
  const versions = new Set(), libraries = new Set(), requirements = [];
  const table = Number(data.readBigUInt64LE(40)), entrySize = data.readUInt16LE(58), count = data.readUInt16LE(60);
  if (!table || !count) return { versions: [], libraries: [], requirements: [] };
  assert.ok(entrySize >= 64 && table + entrySize * count <= data.length, 'Truncated ELF section table');
  const sections = Array.from({ length: count }, (_, index) => {
    const at = table + index * entrySize;
    return { type: data.readUInt32LE(at + 4), offset: Number(data.readBigUInt64LE(at + 24)), size: Number(data.readBigUInt64LE(at + 32)), link: data.readUInt32LE(at + 40) };
  });
  function string(section, offset) {
    assert.ok(section && offset >= 0 && offset < section.size && section.offset + section.size <= data.length, 'Invalid ELF string table');
    const start = section.offset + offset, end = data.indexOf(0, start);
    assert.ok(end >= start && end < section.offset + section.size, 'Unterminated ELF symbol version');
    return data.toString('utf8', start, end);
  }
  for (const section of sections) {
    assert.ok(section.offset >= 0 && section.offset + section.size <= data.length || section.type === 8, 'Truncated ELF section');
    if (section.type === 6) {
      for (let at = section.offset; at + 16 <= section.offset + section.size; at += 16) {
        if (data.readBigInt64LE(at) === 1n) libraries.add(string(sections[section.link], Number(data.readBigUInt64LE(at + 8))));
      }
    }
    if (section.type !== 0x6ffffffe) continue;
    let at = section.offset;
    for (let visited = 0; at + 16 <= section.offset + section.size && visited < section.size / 16; visited++) {
      const entries = data.readUInt16LE(at + 2), next = data.readUInt32LE(at + 12);
      const library = string(sections[section.link], data.readUInt32LE(at + 4));
      let aux = at + data.readUInt32LE(at + 8);
      for (let index = 0; index < entries; index++) {
        assert.ok(aux >= section.offset && aux + 16 <= section.offset + section.size, 'Truncated ELF version requirement');
        const version = string(sections[section.link], data.readUInt32LE(aux + 8));
        versions.add(version);
        requirements.push({ library, version });
        const step = data.readUInt32LE(aux + 12);
        if (!step) break;
        aux += step;
      }
      if (!next) break;
      at += next;
    }
  }
  return { versions: [...versions].sort(), libraries: [...libraries].sort(), requirements };
}

export function validateNativeBinary(name, data) {
  assert.ok(data.length >= 64, `${name} is empty or truncated`);
  if (name.includes('.linux-')) {
    assert.equal(data.subarray(0, 6).toString('hex'), '7f454c460201', `${name} must be a little-endian 64-bit ELF binary`);
    assert.equal(data.readUInt16LE(18), name.includes('-arm64-') ? 183 : 62, `${name} has the wrong CPU architecture`);
    const { versions, libraries, requirements } = elfRequirements(data);
    if (name.includes('-gnu.')) {
      for (const version of versions.filter(version => version.startsWith('GLIBC_'))) {
        const numbers = version.slice(6).split('.').map(Number);
        assert.ok(numbers[0] < 2 || numbers[0] === 2 && numbers[1] <= 28, `${name} requires ${version}; releases must support glibc 2.28`);
      }
      assert.ok(!versions.some(version => version.startsWith('GLIBCXX_')), `${name} unexpectedly requires a C++ runtime`);
    } else {
      // Alpine's ARM64 libgcc versions its frame-registration exports as
      // GLIBC_2.0. The version name belongs to libgcc, not a glibc dependency.
      assert.ok(!requirements.some(({ library, version }) => version.startsWith('GLIBC_') && !(library === 'libgcc_s.so.1' && version === 'GLIBC_2.0')), `${name} links glibc instead of musl`);
      assert.ok(!libraries.some(library => library === 'libc.so.6'), `${name} links glibc instead of musl`);
    }
  } else if (name.includes('.darwin-')) {
    assert.equal(data.readUInt32LE(0), 0xfeedfacf, `${name} must be a 64-bit Mach-O binary`);
    assert.equal(data.readUInt32LE(4), name.includes('-arm64.') ? 0x0100000c : 0x01000007, `${name} has the wrong CPU architecture`);
  } else {
    assert.equal(data.subarray(0, 2).toString(), 'MZ', `${name} must be a Windows PE binary`);
    const offset = data.readUInt32LE(0x3c);
    assert.ok(offset + 6 <= data.length, `${name} has a truncated PE header`);
    assert.equal(data.subarray(offset, offset + 4).toString('hex'), '50450000', `${name} has an invalid PE signature`);
    assert.equal(data.readUInt16LE(offset + 4), name.includes('-arm64-') ? 0xaa64 : 0x8664, `${name} has the wrong Windows CPU architecture`);
  }
}

function allowedFile(path) {
  return requiredFiles.includes(path) || /^dist\/[\w./-]+\.(?:[cm]?js|map|[cm]?ts)$/.test(path)
    || /^(?:src\/[\w/-]+\.ts|native\/src\/[\w/-]+\.rs)$/.test(path)
    || /^native\/vendor\/(?:(?:html5ever|markup5ever)-0\.35\.0|html5gum-0\.8\.4)\/(?:[\w./-]+\.(?:rs|c|h|html|md|toml|orig|json)|Cargo\.lock|LICENSE(?:-(?:MIT|APACHE))?)$/.test(path)
    || /^scripts\/notices\/[\w-]+\.(?:txt|md|json)$/.test(path)
    || nativeTargets.some(target => path === `cheerox.${target}.node`);
}

export function validatePackageFiles(files, { allTargets = true } = {}) {
  for (const path of files.keys()) {
    assert.ok(!path.split('/').some(part => part === '.' || part === '..' || part === 'target' || part === 'node_modules') && !path.includes('\\'), `Unsafe package path: ${path}`);
    assert.ok(allowedFile(path), `Unexpected package file: ${path}`);
  }
  for (const path of requiredFiles) assert.ok(files.get(path)?.length > 0, `Package is missing ${path}`);
  for (const path of ['native/vendor/html5gum-0.8.4/Cargo.toml', 'native/vendor/html5gum-0.8.4/src/lib.rs', 'native/vendor/html5gum-0.8.4/LICENSE']) assert.ok(files.get(path)?.length > 0, `Package is missing ${path}`);
  assert.match(files.get('LICENSE').toString(), /MIT License/);
  assert.match(files.get('THIRD_PARTY_NOTICES.md').toString(), /cheerio/i);
  assert.match(files.get('README.md').toString(), /context\.dev/i);
  const binaries = [...files].filter(([path]) => path.endsWith('.node'));
  assert.ok(binaries.length > 0, 'Package has no native binary');
  if (allTargets) for (const target of nativeTargets) assert.ok(files.has(`cheerox.${target}.node`), `Release is missing the ${target} binary`);
  for (const [path, data] of binaries) validateNativeBinary(path, data);
  const metadata = JSON.parse(files.get('package.json'));
  validateMetadata(metadata, files.get('Cargo.toml').toString());
  return metadata;
}

/** Read regular files only; links and archive paths outside package/ are rejected. */
export function readTarball(path) {
  const tar = gunzipSync(readFileSync(path), { maxOutputLength: 256 * 1024 * 1024 });
  const files = new Map();
  let extended = {};
  const string = bytes => bytes.toString('utf8').replace(/\0.*$/s, '');
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      assert.ok(tar.subarray(offset).every(byte => byte === 0), 'Unexpected data after the tar archive terminator');
      break;
    }
    const checksum = [...header].reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
    assert.equal(checksum, Number.parseInt(string(header.subarray(148, 156)).trim(), 8), 'Invalid tar header checksum');
    const size = Number.parseInt(string(header.subarray(124, 136)).trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, 'Invalid tar entry size');
    const data = tar.subarray(offset + 512, offset + 512 + size);
    const type = header[156];
    let path = string(header.subarray(0, 100));
    const prefix = string(header.subarray(345, 500));
    if (prefix) path = `${prefix}/${path}`;
    if (type === 120) {
      extended = {};
      let index = 0;
      while (index < data.length) {
        const space = data.indexOf(32, index);
        const length = Number(data.subarray(index, space).toString());
        assert.ok(space > index && Number.isSafeInteger(length) && length > space - index && index + length <= data.length, 'Invalid PAX header');
        const entry = data.subarray(space + 1, index + length - 1).toString();
        const separator = entry.indexOf('=');
        assert.ok(separator > 0, 'Invalid PAX attribute');
        extended[entry.slice(0, separator)] = entry.slice(separator + 1);
        index += length;
      }
    } else if (type !== 53) {
      assert.ok(type === 0 || type === 48, 'Package tarball must contain regular files, not links');
      path = extended.path ?? path;
      extended = {};
      assert.ok(path.startsWith('package/'), `Unexpected tarball path: ${path}`);
      path = path.slice('package/'.length);
      assert.ok(!files.has(path), `Duplicate tarball entry: ${path}`);
      files.set(path, data);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function run() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--local') options.local = true;
    else {
      assert.ok(['--tarball', '--manifest', '--verify-manifest', '--commit'].includes(argument), `Unknown argument: ${argument}`);
      assert.ok(args[index + 1], `${argument} requires a value`);
      options[argument.slice(2)] = args[++index];
    }
  }
  if (options.commit) {
    assert.match(options.commit, /^[a-f0-9]{40}$/);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), options.commit, 'Checkout and release commit differ');
  }
  let tarball = options.tarball;
  if (tarball && !tarball.endsWith('.tgz')) {
    const candidates = readdirSync(tarball).filter(path => path.endsWith('.tgz'));
    assert.equal(candidates.length, 1, 'The release directory must contain exactly one npm tarball');
    tarball = join(tarball, candidates[0]);
  }
  let files;
  if (tarball) files = readTarball(tarball);
  else {
    const npm = process.env.npm_execpath;
    const result = npm ? execFileSync(process.execPath, [npm, 'pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8' })
      : execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8' });
    files = new Map(JSON.parse(result)[0].files.map(({ path }) => [path, readFileSync(join(root, path))]));
  }
  const metadata = validatePackageFiles(files, { allTargets: !options.local });
  if (options.commit) for (const [path, contents] of files) {
    if (path.startsWith('dist/') || path.endsWith('.node')) continue;
    const committed = execFileSync('git', ['show', `${options.commit}:${path}`], { cwd: root });
    assert.ok(committed.equals(contents), `${path} differs from the declared release commit`);
  }
  const manifest = { format: 1, name: metadata.name, version: metadata.version, commit: options.commit, filename: tarball ? basename(tarball) : undefined, sha256: tarball ? createHash('sha256').update(readFileSync(tarball)).digest('hex') : undefined, targets: nativeTargets.filter(target => files.has(`cheerox.${target}.node`)) };
  if (options.manifest) {
    assert.ok(tarball && options.commit && !options.local, 'Release manifests require a complete tarball and exact commit');
    writeFileSync(options.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (options['verify-manifest']) assert.deepEqual(JSON.parse(readFileSync(options['verify-manifest'])), manifest, 'Release artifact does not match its tested manifest');
  console.log(`${metadata.name}@${metadata.version}: package contents, license, source, zero npm dependencies and ${manifest.targets.length} native targets verified${options.local ? ' (local platform check)' : ''}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
