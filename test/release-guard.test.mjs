import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { elfRequirements, validateMetadata, validateNativeBinary, validateVersion } from '../scripts/check-release.mjs';

const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const cargo = readFileSync(new URL('../Cargo.toml', import.meta.url), 'utf8');

test('release checks reject npm runtime dependencies, registry mistakes and version drift', () => {
  validateMetadata(metadata, cargo);
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.throws(() => validateMetadata({ ...metadata, [key]: { unexpected: '1.0.0' } }, cargo), /must remain empty/);
  }
  assert.throws(() => validateMetadata({ ...metadata, publishConfig: { ...metadata.publishConfig, registry: 'https://example.com/' } }, cargo));
  assert.throws(() => validateMetadata(metadata, cargo.replace(/version = "[^"]+"/, 'version = "999.0.0"')), /versions must match/);
});

test('release version checks reject ambiguous tags and prereleases on latest', () => {
  assert.equal(validateVersion('1.2.3', 'latest'), 'v1.2.3');
  assert.equal(validateVersion('1.2.3-rc.1', 'next'), 'v1.2.3-rc.1');
  for (const version of ['v1.2.3', '1.2', '01.2.3', '1.2.3-rc.01', '1.2.3+build', '../main', '1.2.3\n']) assert.throws(() => validateVersion(version, 'next'));
  assert.throws(() => validateVersion('1.2.3-rc.1', 'latest'), /Prereleases/);
});

test('release binary checks reject mislabeled architectures and placeholder files', () => {
  const elf = Buffer.alloc(64);
  Buffer.from('7f454c460201', 'hex').copy(elf);
  elf.writeUInt16LE(62, 18);
  validateNativeBinary('cheerox.linux-x64-gnu.node', elf);
  assert.throws(() => validateNativeBinary('cheerox.linux-arm64-gnu.node', elf), /wrong CPU architecture/);
  assert.throws(() => validateNativeBinary('cheerox.darwin-x64.node', elf), /Mach-O/);
  assert.throws(() => validateNativeBinary('cheerox.win32-x64-msvc.node', Buffer.from('placeholder')), /truncated/);
});

test('release ABI checks inspect actual ELF version requirements and Windows ARM64 headers', () => {
  function elf(version, library = 'libc.so.6') {
    const data = Buffer.alloc(384);
    Buffer.from('7f454c460201', 'hex').copy(data);
    data.writeUInt16LE(62, 18);
    data.writeBigUInt64LE(64n, 40);
    data.writeUInt16LE(64, 58);
    data.writeUInt16LE(3, 60);
    data.writeUInt32LE(3, 132);
    data.writeBigUInt64LE(256n, 152);
    data.writeBigUInt64LE(64n, 160);
    data.writeUInt32LE(0x6ffffffe, 196);
    data.writeBigUInt64LE(320n, 216);
    data.writeBigUInt64LE(32n, 224);
    data.writeUInt32LE(1, 232);
    const strings = Buffer.from(`\0${library}\0${version}\0`);
    strings.copy(data, 256);
    data.writeUInt16LE(1, 320);
    data.writeUInt16LE(1, 322);
    data.writeUInt32LE(1, 324);
    data.writeUInt32LE(16, 328);
    data.writeUInt32LE(strings.indexOf(Buffer.from(version)), 344);
    return data;
  }
  assert.deepEqual(elfRequirements(elf('GLIBC_2.28')).versions, ['GLIBC_2.28']);
  validateNativeBinary('cheerox.linux-x64-gnu.node', elf('GLIBC_2.28'));
  assert.throws(() => validateNativeBinary('cheerox.linux-x64-gnu.node', elf('GLIBC_2.34')), /must support glibc 2.28/);
  assert.throws(() => validateNativeBinary('cheerox.linux-x64-musl.node', elf('GLIBC_2.28')), /links glibc/);
  const alpineFrameVersions = elf('GLIBC_2.0', 'libgcc_s.so.1');
  alpineFrameVersions.writeUInt16LE(183, 18);
  assert.deepEqual(elfRequirements(alpineFrameVersions).requirements, [{ library: 'libgcc_s.so.1', version: 'GLIBC_2.0' }]);
  validateNativeBinary('cheerox.linux-arm64-musl.node', alpineFrameVersions);
  assert.throws(() => validateNativeBinary('cheerox.linux-x64-musl.node', elf('GLIBC_2.0')), /links glibc/);
  assert.throws(() => validateNativeBinary('cheerox.linux-x64-musl.node', elf('GLIBC_2.34', 'libgcc_s.so.1')), /links glibc/);
  const pe = Buffer.alloc(128);
  pe.write('MZ');
  pe.writeUInt32LE(64, 0x3c);
  Buffer.from('50450000', 'hex').copy(pe, 64);
  pe.writeUInt16LE(0xaa64, 68);
  validateNativeBinary('cheerox.win32-arm64-msvc.node', pe);
  assert.throws(() => validateNativeBinary('cheerox.win32-x64-msvc.node', pe), /wrong Windows CPU/);
});

test('release references require a public repository and the exact tagged main commit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cheerox release ref '));
  try {
    mkdirSync(join(directory, 'scripts'));
    for (const script of ['check-release.mjs', 'check-release-ref.mjs']) cpSync(new URL(`../scripts/${script}`, import.meta.url), join(directory, 'scripts', script));
    writeFileSync(join(directory, 'package.json'), JSON.stringify(metadata));
    writeFileSync(join(directory, 'Cargo.toml'), cargo);
    const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '--quiet', '--initial-branch=main']);
    git(['add', '.']);
    git(['-c', 'user.name=Release test', '-c', 'user.email=release@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Release fixture']);
    const commit = git(['rev-parse', 'HEAD']);
    git(['-c', 'tag.gpgsign=false', 'tag', `v${metadata.version}`]);
    git(['update-ref', 'refs/remotes/origin/main', commit]);
    const environment = { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'dvaJi/cheerox', GITHUB_SHA: commit, REPOSITORY_VISIBILITY: 'public', RELEASE_VERSION: metadata.version, NPM_DIST_TAG: metadata.version.includes('-') ? 'next' : 'latest', GITHUB_OUTPUT: join(directory, 'output') };
    const check = changes => execFileSync(process.execPath, [join(directory, 'scripts/check-release-ref.mjs')], { cwd: directory, env: { ...environment, ...changes }, stdio: ['ignore', 'pipe', 'pipe'] });
    check({});
    assert.match(readFileSync(environment.GITHUB_OUTPUT, 'utf8'), new RegExp(`commit=${commit}`));
    assert.throws(() => check({ REPOSITORY_VISIBILITY: 'private' }), /repository public/);
    assert.throws(() => check({ GITHUB_REPOSITORY: 'another/cheerox' }), /fork is disabled/);
    assert.throws(() => check({ GITHUB_SHA: '0'.repeat(40) }), /exact main workflow commit/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
