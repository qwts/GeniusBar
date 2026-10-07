import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import {
  NODE_PLATFORMS, UNIVERSAL_TARGETS, fetchNode, nodeArchive, nodeArchiveName, nodeMember, shippedEntries, sidecarName, stampFor, tagCommit, tarCommand } from './fetch-components.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** A stored (uncompressed) zip of `{ name: content }`, the way Node ships Windows. */
function storedZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const fixed = Buffer.alloc(26);
    fixed.writeUInt16LE(20, 0); // version needed
    fixed.writeUInt16LE(0, 2); // flags
    fixed.writeUInt16LE(0, 4); // stored
    fixed.writeUInt16LE(0, 6); // time
    fixed.writeUInt16LE(0x21, 8); // 1980-01-01
    fixed.writeUInt32LE(crc, 10);
    fixed.writeUInt32LE(data.length, 14);
    fixed.writeUInt32LE(data.length, 18);
    fixed.writeUInt16LE(nameBytes.length, 22);
    fixed.writeUInt16LE(0, 24);
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), fixed, nameBytes, data]);
    const head = Buffer.alloc(16);
    head.writeUInt16LE(20, 0); // made by
    const tail = Buffer.alloc(14);
    tail.writeUInt32LE(offset, 10); // local header offset
    central.push(Buffer.concat([Buffer.from([0x50, 0x4b, 0x01, 0x02]), head.subarray(0, 2), fixed, tail, nameBytes]));
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(18);
  end.writeUInt16LE(central.length, 4);
  end.writeUInt16LE(central.length, 6);
  end.writeUInt32LE(directory.length, 8);
  end.writeUInt32LE(offset, 12);
  return Buffer.concat([...locals, directory, Buffer.from([0x50, 0x4b, 0x05, 0x06]), end]);
}

const pins = JSON.parse(readFileSync(new URL('../components.json', import.meta.url), 'utf8'));

test('every supported target has a pinned Node checksum', () => {
  for (const platform of Object.values(NODE_PLATFORMS)) {
    assert.match(pins.node.sha256[platform] ?? '', /^[0-9a-f]{64}$/, platform);
  }
});

test('components are pinned to release tags and their commits', () => {
  for (const [name, pin] of Object.entries(pins.components)) {
    assert.match(pin.ref, /^[0-9a-f]{40}$/, name);
    assert.match(pin.tag, /^v\d+\.\d+\.\d+$/, name);
    assert.match(pin.repo, /^[\w.-]+\/[\w.-]+$/, name);
  }
});

test('resolves lightweight and annotated tags to their commit', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  assert.equal(tagCommit(`${a}\trefs/tags/v1.0.0`, 'v1.0.0'), a);
  assert.equal(tagCommit(`${a}\trefs/tags/v1.0.0\n${b}\trefs/tags/v1.0.0^{}`, 'v1.0.0'), b);
  assert.equal(tagCommit(`${a}\trefs/tags/v1.0.10`, 'v1.0.1'), null);
});

test('the universal macOS target joins both pinned darwin binaries', () => {
  const parts = UNIVERSAL_TARGETS['universal-apple-darwin'];
  assert.deepEqual(parts, ['aarch64-apple-darwin', 'x86_64-apple-darwin']);
  for (const part of parts) assert.ok(NODE_PLATFORMS[part], part);
});

test('sidecars carry the triple Tauri looks up', () => {
  assert.equal(sidecarName('universal-apple-darwin'), 'node-universal-apple-darwin');
  assert.equal(sidecarName('aarch64-apple-darwin'), 'node-aarch64-apple-darwin');
  assert.equal(sidecarName('x86_64-pc-windows-msvc'), 'node-x86_64-pc-windows-msvc.exe');
});

test('a universal stamp changes when either slice is repinned', () => {
  const pins = { version: '1.2.3', sha256: { 'darwin-arm64': 'a', 'darwin-x64': 'b' } };
  assert.equal(stampFor('aarch64-apple-darwin', pins), '1.2.3 a');
  assert.equal(stampFor('universal-apple-darwin', pins), '1.2.3 a b');
  const repinned = { ...pins, sha256: { ...pins.sha256, 'darwin-x64': 'c' } };
  assert.notEqual(stampFor('universal-apple-darwin', repinned), stampFor('universal-apple-darwin', pins));
  assert.throws(() => stampFor('riscv64-unknown-linux-gnu', pins), /no bundled Node/);
});

test('npm comes from the pinned Node archive, on every platform', () => {
  assert.equal(nodeMember('darwin-arm64', 'npm', '1.2.3'), 'node-v1.2.3-darwin-arm64/lib/node_modules/npm');
  assert.equal(nodeMember('win-x64', 'npm', '1.2.3'), 'node-v1.2.3-win-x64/node_modules/npm');
  assert.equal(nodeMember('darwin-x64', 'node', '1.2.3'), 'node-v1.2.3-darwin-x64/bin/node');
  assert.equal(nodeMember('win-arm64', 'node', '1.2.3'), 'node-v1.2.3-win-arm64/node.exe');
});

test('Windows ships Node as a zip, verified like the tarballs', () => {
  assert.equal(nodeArchiveName('win-x64', '1.2.3'), 'node-v1.2.3-win-x64.zip');
  assert.equal(nodeArchiveName('win-arm64', '1.2.3'), 'node-v1.2.3-win-arm64.zip');
  assert.equal(nodeArchiveName('darwin-arm64', '1.2.3'), 'node-v1.2.3-darwin-arm64.tar.gz');
});

test('the Node archive is fetched once, verified every time, and a bad one is dropped', async (t) => {
  const cache = mkdtempSync(path.join(tmpdir(), 'node-cache-'));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const body = Buffer.from('not really node');
  const calls = [];
  const fetchFn = async (url) => { calls.push(url); return { ok: true, arrayBuffer: async () => body }; };
  const bad = { version: '1.2.3', sha256: { 'win-x64': 'f'.repeat(64) } };
  await assert.rejects(nodeArchive('win-x64', { pins: bad, cache, fetchFn }), /SHA-256/);
  assert.deepEqual(calls, ['https://nodejs.org/dist/v1.2.3/node-v1.2.3-win-x64.zip']);
  assert.equal(existsSync(path.join(cache, 'node-v1.2.3-win-x64.zip')), false);
  const good = { version: '1.2.3', sha256: { 'win-x64': sha256(body) } };
  const file = await nodeArchive('win-x64', { pins: good, cache, fetchFn });
  assert.equal(path.basename(file), 'node-v1.2.3-win-x64.zip');
  await nodeArchive('win-x64', { pins: good, cache, fetchFn });
  assert.equal(calls.length, 2);
  // A 404 is reported as such, not as a checksum mismatch.
  await assert.rejects(nodeArchive('win-arm64', {
    pins: { version: '1.2.3', sha256: { 'win-arm64': 'a'.repeat(64) } }, cache, fetchFn: async () => ({ ok: false, status: 404 }),
  }), /returned 404/);
});

test('a Windows target lands node.exe from the zip root as the .exe sidecar, and is reused', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'node-win-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = path.join(dir, 'cache');
  const binaries = path.join(dir, 'binaries');
  const zip = storedZip({
    'node-v1.2.3-win-x64/node.exe': 'MZ fake node',
    'node-v1.2.3-win-x64/npm.cmd': 'not wanted',
    'node-v1.2.3-win-x64/node_modules/npm/package.json': '{}',
  });
  const pins = { version: '1.2.3', sha256: { 'win-x64': sha256(zip) } };
  const calls = [];
  const fetchFn = async (url) => { calls.push(url); return { ok: true, arrayBuffer: async () => zip }; };
  const out = await fetchNode('x86_64-pc-windows-msvc', { pins, cache, binaries, fetchFn });
  assert.equal(path.relative(binaries, out), 'node-x86_64-pc-windows-msvc.exe');
  assert.equal(readFileSync(out, 'utf8'), 'MZ fake node');
  assert.equal(readFileSync(`${out}.version`, 'utf8'), `1.2.3 ${sha256(zip)}`);
  assert.deepEqual(calls, ['https://nodejs.org/dist/v1.2.3/node-v1.2.3-win-x64.zip']);
  // Only the sidecar is kept: nothing else from the zip reaches binaries.
  assert.equal(existsSync(path.join(binaries, 'npm.cmd')), false);
  // The stamp matches the pin: nothing is fetched again.
  await fetchNode('x86_64-pc-windows-msvc', { pins, cache, binaries, fetchFn });
  assert.equal(calls.length, 1);
  // A repin fetches again.
  const repinned = storedZip({ 'node-v1.2.4-win-x64/node.exe': 'MZ newer node' });
  await fetchNode('x86_64-pc-windows-msvc', {
    pins: { version: '1.2.4', sha256: { 'win-x64': sha256(repinned) } }, cache, binaries,
    fetchFn: async () => ({ ok: true, arrayBuffer: async () => repinned }),
  });
  assert.equal(readFileSync(out, 'utf8'), 'MZ newer node');
  await assert.rejects(fetchNode('riscv64-unknown-linux-gnu', { pins, cache, binaries, fetchFn }), /no bundled Node/);
});

test('a component ships its package files, or everything but the development paths', () => {
  const tree = ['.github', 'LICENSE', 'bin', 'docs', 'lib', 'package.json', 'tests'];
  assert.deepEqual(shippedEntries(tree, { files: ['bin/', 'lib'] }), ['LICENSE', 'bin', 'lib', 'package.json']);
  assert.deepEqual(shippedEntries(tree, {}), ['LICENSE', 'bin', 'lib', 'package.json']);
});

test('on Windows the archives go through System32 bsdtar by its full path, not a GNU tar on PATH', () => {
  // Git for Windows' GNU tar reads `D:\...` as a remote host ("Cannot connect to D:").
  assert.equal(tarCommand('darwin', {}), 'tar');
  assert.equal(tarCommand('linux', {}), 'tar');
  assert.equal(tarCommand('win32', { SystemRoot: 'C:\\WINDOWS' }), path.join('C:\\WINDOWS', 'System32', 'tar.exe'));
  assert.equal(tarCommand('win32', {}), path.join('C:\\Windows', 'System32', 'tar.exe'));
});
