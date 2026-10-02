import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NODE_PLATFORMS, UNIVERSAL_TARGETS, sidecarName, stampFor, tagCommit } from './fetch-components.mjs';

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
