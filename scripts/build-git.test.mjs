import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { archOf, buildGit, fetchTarball, gitSidecarName, makeArguments, SIDECARS, sliceFile } from './build-git.mjs';

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
