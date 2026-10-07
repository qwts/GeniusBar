import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  archOf, buildGit, fetchMinGit, fetchTarball, gitSidecarName, isWindowsTarget, makeArguments, mingitRelease, SIDECARS, sliceFile, unpackMinGit,
} from './build-git.mjs';

const PINS = JSON.parse(readFileSync(new URL('../components.json', import.meta.url), 'utf8'));

test('git is pinned by version and SHA-256 like node', () => {
  assert.match(PINS.git.version, /^2\.\d+\.\d+$/);
  assert.match(PINS.git.sha256, /^[0-9a-f]{64}$/);
});

test('the sidecars are named the way Tauri looks for externalBin', () => {
  assert.deepEqual(SIDECARS, ['git', 'git-remote-https']);
  assert.equal(gitSidecarName('git', 'universal-apple-darwin'), 'git-universal-apple-darwin');
  assert.equal(gitSidecarName('git-remote-https', 'aarch64-apple-darwin'), 'git-remote-https-aarch64-apple-darwin');
  assert.equal(archOf('aarch64-apple-darwin'), 'arm64');
  assert.equal(archOf('x86_64-apple-darwin'), 'x86_64');
  assert.throws(() => archOf('x86_64-pc-windows-msvc'), /only for macOS/);
});

test('each slice is built relocatable, without the optional parts, for one architecture', () => {
  const args = makeArguments('x86_64', '/out');
  assert.ok(args.includes('RUNTIME_PREFIX=YesPlease'));
  for (const off of ['NO_GETTEXT=1', 'NO_PERL=1', 'NO_PYTHON=1', 'NO_TCLTK=1', 'NO_EXPAT=1', 'NO_RUST=1', 'NO_INSTALL_HARDLINKS=1']) {
    assert.ok(args.includes(off), off);
  }
  assert.ok(args.includes('CFLAGS=-O2 -arch x86_64'));
  assert.ok(args.includes('LDFLAGS=-arch x86_64'));
  assert.ok(args.includes('DESTDIR=/out'));
  assert.equal(args.at(-1), 'install');
  // The https helper is git's http helper; git picks it by name.
  assert.equal(sliceFile('/out', 'git'), '/out/bin/git');
  assert.equal(sliceFile('/out', 'git-remote-https'), '/out/libexec/git-core/git-remote-http');
});

test('the tarball is fetched once, verified every time, and a bad one is dropped', async (t) => {
  const cache = mkdtempSync(path.join(tmpdir(), 'git-cache-'));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const body = Buffer.from('not really git');
  const pins = { version: '2.0.0', sha256: '9b14c6f6b0a2f7b1a8c0c2b1ab2d8de0d5e3f4d0a4c0b9e0f4c7a3e4bbf7d1cc' };
  const calls = [];
  const fetchFn = async (url) => { calls.push(url); return { ok: true, arrayBuffer: async () => body }; };
  await assert.rejects(fetchTarball(pins, { cache, fetchFn }), /SHA-256/);
  assert.deepEqual(calls, ['https://mirrors.edge.kernel.org/pub/software/scm/git/git-2.0.0.tar.xz']);
  assert.equal(existsSync(path.join(cache, 'git-2.0.0.tar.xz')), false);
  const { createHash } = await import('node:crypto');
  const good = { version: '2.0.0', sha256: createHash('sha256').update(body).digest('hex') };
  const file = await fetchTarball(good, { cache, fetchFn });
  assert.equal(path.basename(file), 'git-2.0.0.tar.xz');
  await fetchTarball(good, { cache, fetchFn });
  assert.equal(calls.length, 2);
});

test('a universal build leaves each slice sidecar beside the lipo’d ones, copies the templates, and is reused', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'git-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binaries = path.join(dir, 'binaries');
  const templates = path.join(dir, 'git-templates');
  const pins = { version: '2.56.0', sha256: 'a'.repeat(64) };
  const builds = [];
  const copies = [];
  const lipos = [];
  const build = (tarball, version, triple) => {
    builds.push([tarball, version, triple]);
    const out = path.join(dir, triple);
    mkdirSync(path.join(out, 'bin'), { recursive: true });
    mkdirSync(path.join(out, 'libexec', 'git-core'), { recursive: true });
    mkdirSync(path.join(out, 'share', 'git-core', 'templates', 'info'), { recursive: true });
    writeFileSync(path.join(out, 'share', 'git-core', 'templates', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n');
    return out;
  };
  const options = {
    binaries, templates, pins, tarball: '/cache/git-2.56.0.tar.xz', build,
    copy: (from, to) => { copies.push([path.relative(dir, from), path.basename(to)]); writeFileSync(to, ''); },
    lipo: (args) => { lipos.push(args.map((a) => (a.startsWith('-') ? a : path.relative(dir, a)))); writeFileSync(args.at(-1), ''); },
  };
  const outputs = buildGit('universal-apple-darwin', options);
  assert.deepEqual(outputs.map((out) => path.basename(out)), ['git-universal-apple-darwin', 'git-remote-https-universal-apple-darwin']);
  assert.deepEqual(builds, [
    ['/cache/git-2.56.0.tar.xz', '2.56.0', 'aarch64-apple-darwin'],
    ['/cache/git-2.56.0.tar.xz', '2.56.0', 'x86_64-apple-darwin'],
  ]);
  assert.deepEqual(copies, [
    ['aarch64-apple-darwin/bin/git', 'git-aarch64-apple-darwin'],
    ['x86_64-apple-darwin/bin/git', 'git-x86_64-apple-darwin'],
    ['aarch64-apple-darwin/libexec/git-core/git-remote-http', 'git-remote-https-aarch64-apple-darwin'],
    ['x86_64-apple-darwin/libexec/git-core/git-remote-http', 'git-remote-https-x86_64-apple-darwin'],
  ]);
  assert.deepEqual(lipos, [
    ['-create', 'aarch64-apple-darwin/bin/git', 'x86_64-apple-darwin/bin/git', '-output', 'binaries/git-universal-apple-darwin'],
    ['-create', 'aarch64-apple-darwin/libexec/git-core/git-remote-http', 'x86_64-apple-darwin/libexec/git-core/git-remote-http', '-output', 'binaries/git-remote-https-universal-apple-darwin'],
  ]);
  assert.ok(existsSync(path.join(templates, 'info', 'exclude')));
  assert.equal(readFileSync(path.join(binaries, 'git-universal-apple-darwin.version'), 'utf8'), `2.56.0 ${'a'.repeat(64)}`);
  // The stamp matches the pin: nothing is built again.
  buildGit('universal-apple-darwin', options);
  assert.equal(builds.length, 2);
  // A new pin builds again.
  buildGit('universal-apple-darwin', { ...options, pins: { version: '2.57.0', sha256: 'b'.repeat(64) } });
  assert.equal(builds.length, 4);
  assert.equal(readFileSync(path.join(binaries, 'git-universal-apple-darwin.version'), 'utf8'), `2.57.0 ${'b'.repeat(64)}`);
});

test('a single-slice build copies without lipo', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'git-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'slice');
  mkdirSync(path.join(out, 'share', 'git-core', 'templates'), { recursive: true });
  const copies = [];
  let lipoed = false;
  buildGit('aarch64-apple-darwin', {
    binaries: path.join(dir, 'binaries'), templates: path.join(dir, 'templates'), pins: { version: '2.56.0', sha256: 'a'.repeat(64) },
    tarball: '/t', build: () => out, copy: (from, to) => { copies.push(path.basename(to)); writeFileSync(to, ''); }, lipo: () => { lipoed = true; },
  });
  assert.deepEqual(copies, ['git-aarch64-apple-darwin', 'git-remote-https-aarch64-apple-darwin']);
  assert.equal(lipoed, false);
  assert.throws(() => buildGit('x86_64-pc-windows-msvc', {}), /only for macOS/);
});

test('MinGit is pinned by version and SHA-256, to a Git for Windows release of the pinned git', () => {
  assert.match(PINS.mingit.version, /^2\.\d+\.\d+(?:\.\d+)?$/);
  assert.match(PINS.mingit.sha256, /^[0-9a-f]{64}$/);
  assert.ok(PINS.mingit.version.startsWith(`${PINS.git.version}.`) || PINS.mingit.version === PINS.git.version, 'MinGit follows the git pin');
  assert.equal(isWindowsTarget('x86_64-pc-windows-msvc'), true);
  assert.equal(isWindowsTarget('aarch64-pc-windows-msvc'), true);
  assert.equal(isWindowsTarget('universal-apple-darwin'), false);
});

test('a MinGit pin names the Git for Windows tag, the 64-bit asset and the version git reports', () => {
  assert.deepEqual(mingitRelease({ version: '2.56.0.2' }), {
    tag: 'v2.56.0.windows.2',
    asset: 'MinGit-2.56.0.2-64-bit.zip',
    url: 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/MinGit-2.56.0.2-64-bit.zip',
    gitVersion: '2.56.0.windows.2',
  });
  assert.equal(mingitRelease({ version: '2.57.0' }).tag, 'v2.57.0.windows.1');
  assert.equal(mingitRelease({ version: '2.57.0' }).asset, 'MinGit-2.57.0-64-bit.zip');
  assert.equal(mingitRelease({ version: '2.57.0' }).gitVersion, '2.57.0.windows.1');
  assert.throws(() => mingitRelease({ version: 'v2.57.0' }), /not a Git for Windows version/);
});

test('the MinGit zip is fetched once, verified every time, and a bad one is dropped', async (t) => {
  const cache = mkdtempSync(path.join(tmpdir(), 'mingit-cache-'));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const body = Buffer.from('not really MinGit');
  const calls = [];
  const fetchFn = async (url) => { calls.push(url); return { ok: true, arrayBuffer: async () => body }; };
  await assert.rejects(fetchMinGit({ version: '2.56.0.2', sha256: 'e'.repeat(64) }, { cache, fetchFn }), /SHA-256/);
  assert.deepEqual(calls, ['https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/MinGit-2.56.0.2-64-bit.zip']);
  assert.equal(existsSync(path.join(cache, 'MinGit-2.56.0.2-64-bit.zip')), false);
  const { createHash } = await import('node:crypto');
  const good = { version: '2.56.0.2', sha256: createHash('sha256').update(body).digest('hex') };
  const file = await fetchMinGit(good, { cache, fetchFn });
  assert.equal(path.basename(file), 'MinGit-2.56.0.2-64-bit.zip');
  await fetchMinGit(good, { cache, fetchFn });
  assert.equal(calls.length, 2);
});

test('a Windows target unpacks MinGit whole into resources/git, stamped, and is reused', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mingit-unpack-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const resources = path.join(dir, 'git');
  const pins = { version: '2.56.0.2', sha256: 'a'.repeat(64) };
  const unzips = [];
  const unzip = (zip, dest) => {
    unzips.push([path.basename(zip), path.relative(dir, dest)]);
    mkdirSync(path.join(dest, 'cmd'), { recursive: true });
    writeFileSync(path.join(dest, 'cmd', 'git.exe'), 'MZ');
    writeFileSync(path.join(dest, 'LICENSE.txt'), 'GPL-2.0');
  };
  const out = unpackMinGit('x86_64-pc-windows-msvc', { zip: '/cache/MinGit-2.56.0.2-64-bit.zip', resources, pins, unzip });
  assert.equal(out, resources);
  assert.deepEqual(unzips, [['MinGit-2.56.0.2-64-bit.zip', 'git']]);
  assert.ok(existsSync(path.join(resources, 'cmd', 'git.exe')));
  assert.equal(readFileSync(path.join(dir, 'git.version'), 'utf8'), `2.56.0.2 ${'a'.repeat(64)}`);
  // The stamp matches the pin: nothing is unpacked again.
  unpackMinGit('x86_64-pc-windows-msvc', { zip: '/cache/MinGit-2.56.0.2-64-bit.zip', resources, pins, unzip });
  assert.equal(unzips.length, 1);
  // A new pin replaces the tree.
  writeFileSync(path.join(resources, 'stale.txt'), '');
  unpackMinGit('x86_64-pc-windows-msvc', { zip: '/cache/MinGit-2.57.0-64-bit.zip', resources, pins: { version: '2.57.0', sha256: 'b'.repeat(64) }, unzip });
  assert.equal(unzips.length, 2);
  assert.equal(existsSync(path.join(resources, 'stale.txt')), false);
  assert.equal(readFileSync(path.join(dir, 'git.version'), 'utf8'), `2.57.0 ${'b'.repeat(64)}`);
  // A zip without git's launcher is not MinGit.
  assert.throws(
    () => unpackMinGit('x86_64-pc-windows-msvc', { zip: '/cache/x.zip', resources, pins: { version: '2.58.0', sha256: 'c'.repeat(64) }, unzip: () => {} }),
    /no cmd\/git.exe/,
  );
  assert.throws(() => unpackMinGit('universal-apple-darwin', { zip: '/cache/x.zip', resources, pins, unzip }), /only for Windows/);
});
