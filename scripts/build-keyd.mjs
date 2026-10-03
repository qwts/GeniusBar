#!/usr/bin/env node
// Builds agent-bot-keyd (keyd/, agent-bot-identity #397) into the sidecar
// Tauri bundles next to node: src-tauri/binaries/agent-bot-keyd-<triple>.
// Tauri signs it with the app's identity, so the Keychain items keyd creates
// trust GeniusBar's Developer ID signature and nothing else.
//
// usage: node scripts/build-keyd.mjs [--target RUST_TRIPLE]
// Like fetch-components.mjs, the target comes from --target, then
// TAURI_ENV_TARGET_TRIPLE, then the host. universal-apple-darwin builds both
// darwin slices and joins them with lipo.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIVERSAL_TARGETS } from './fetch-components.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE = path.join(ROOT, 'keyd');
const BINARIES = path.join(ROOT, 'src-tauri', 'binaries');

export function keydSidecarName(triple) {
  return `agent-bot-keyd-${triple}`;
}

function hostTriple() {
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
  if (process.platform !== 'darwin' || !arch) throw new Error(`agent-bot-keyd builds only for macOS, not ${process.platform}-${process.arch}`);
  return `${arch}-apple-darwin`;
}

export function parseTarget(argv, env) {
  const i = argv.indexOf('--target');
  return i >= 0 ? argv[i + 1] : env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
}

function cargoBuild(triple) {
  execFileSync('cargo', ['build', '--release', '--locked', '--target', triple], { cwd: CRATE, stdio: 'inherit' });
  return path.join(CRATE, 'target', triple, 'release', 'agent-bot-keyd');
}

export function buildKeyd(triple) {
  if (!triple.endsWith('-apple-darwin')) throw new Error(`agent-bot-keyd builds only for macOS targets, not ${triple}`);
  mkdirSync(BINARIES, { recursive: true });
  const out = path.join(BINARIES, keydSidecarName(triple));
  const parts = UNIVERSAL_TARGETS[triple];
  if (parts) execFileSync('lipo', ['-create', ...parts.map(cargoBuild), '-output', out]);
  else copyFileSync(cargoBuild(triple), out);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = buildKeyd(parseTarget(process.argv.slice(2), process.env));
  process.stdout.write(`agent-bot-keyd: ${path.relative(ROOT, out)}\n`);
}
