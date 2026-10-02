import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NODE_PLATFORMS } from './fetch-components.mjs';

const pins = JSON.parse(readFileSync(new URL('../components.json', import.meta.url), 'utf8'));

test('every supported target has a pinned Node checksum', () => {
  for (const platform of Object.values(NODE_PLATFORMS)) {
    assert.match(pins.node.sha256[platform] ?? '', /^[0-9a-f]{64}$/, platform);
  }
});

test('components are pinned to full commit SHAs', () => {
  for (const [name, pin] of Object.entries(pins.components)) {
    assert.match(pin.ref, /^[0-9a-f]{40}$/, name);
    assert.match(pin.repo, /^[\w.-]+\/[\w.-]+$/, name);
  }
});
