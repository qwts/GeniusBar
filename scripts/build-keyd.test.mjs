import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keydSidecarName, parseTarget } from './build-keyd.mjs';

test('the keyd sidecar is named the way Tauri looks for externalBin', () => {
  assert.equal(keydSidecarName('universal-apple-darwin'), 'agent-bot-keyd-universal-apple-darwin');
  assert.equal(keydSidecarName('aarch64-apple-darwin'), 'agent-bot-keyd-aarch64-apple-darwin');
});

test('the target comes from --target, then Tauri, then the host', () => {
  assert.equal(parseTarget(['--target', 'universal-apple-darwin'], {}), 'universal-apple-darwin');
  assert.equal(parseTarget([], { TAURI_ENV_TARGET_TRIPLE: 'x86_64-apple-darwin' }), 'x86_64-apple-darwin');
  if (process.platform === 'darwin') assert.match(parseTarget([], {}), /-apple-darwin$/);
});
