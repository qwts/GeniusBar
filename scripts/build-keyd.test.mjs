import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildKeyd, keydSidecarName, parseTarget } from './build-keyd.mjs';

test('the keyd sidecar is named the way Tauri looks for externalBin', () => {
  assert.equal(keydSidecarName('universal-apple-darwin'), 'agent-bot-keyd-universal-apple-darwin');
  assert.equal(keydSidecarName('aarch64-apple-darwin'), 'agent-bot-keyd-aarch64-apple-darwin');
});

test('the target comes from --target, then Tauri, then the host', () => {
  assert.equal(parseTarget(['--target', 'universal-apple-darwin'], {}), 'universal-apple-darwin');
  assert.equal(parseTarget([], { TAURI_ENV_TARGET_TRIPLE: 'x86_64-apple-darwin' }), 'x86_64-apple-darwin');
  if (process.platform === 'darwin') assert.match(parseTarget([], {}), /-apple-darwin$/);
});

test('a universal build leaves each slice sidecar beside the universal one', (t) => {
  const binaries = mkdtempSync(path.join(tmpdir(), 'keyd-bin-'));
  t.after(() => rmSync(binaries, { recursive: true, force: true }));
  const copies = [];
  let lipoArgs;
  const out = buildKeyd('universal-apple-darwin', {
    binaries,
    build: (triple) => `/built/${triple}`,
    copy: (from, to) => copies.push([from, path.basename(to)]),
    lipo: (args) => { lipoArgs = args; },
  });
  assert.equal(path.basename(out), 'agent-bot-keyd-universal-apple-darwin');
  assert.deepEqual(copies, [
    ['/built/aarch64-apple-darwin', 'agent-bot-keyd-aarch64-apple-darwin'],
    ['/built/x86_64-apple-darwin', 'agent-bot-keyd-x86_64-apple-darwin'],
  ]);
  assert.deepEqual(lipoArgs, ['-create', '/built/aarch64-apple-darwin', '/built/x86_64-apple-darwin', '-output', out]);
});
