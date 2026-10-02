import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NODE_PLATFORMS, tagCommit } from './fetch-components.mjs';

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
