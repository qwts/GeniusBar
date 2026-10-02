#!/usr/bin/env node
// Fetches what GeniusBar bundles (ADR-0004 decision 3), pinned in
// components.json: the official Node binary, verified by SHA-256, becomes the
// Tauri sidecar; agent-comms and agent-bot, fetched by commit so git verifies
// their content, become app resources. Nothing here uses a Node or a package
// the user installed.
//
// usage: node scripts/fetch-components.mjs [--target RUST_TRIPLE]
// Tauri sets TAURI_ENV_TARGET_TRIPLE for its before-build commands.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PINS = JSON.parse(readFileSync(path.join(ROOT, 'components.json'), 'utf8'));
const CACHE = path.join(ROOT, '.cache');
const BINARIES = path.join(ROOT, 'src-tauri', 'binaries');
const RESOURCES = path.join(ROOT, 'src-tauri', 'resources', 'components');

export const NODE_PLATFORMS = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'aarch64-pc-windows-msvc': 'win-arm64',
  'x86_64-pc-windows-msvc': 'win-x64',
};

// Paths a component never needs at runtime when it has no package "files".
const EXCLUDED = new Set(['.github', 'docs', 'tests', 'Formula', 'governance']);

function hostTriple() {
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
  const os = { darwin: 'apple-darwin', win32: 'pc-windows-msvc' }[process.platform];
  if (!arch || !os) throw new Error(`no bundled Node for ${process.platform}-${process.arch}`);
  return `${arch}-${os}`;
}

function parseTarget(argv, env) {
  const i = argv.indexOf('--target');
  return i >= 0 ? argv[i + 1] : env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function download(url, file) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

export async function fetchNode(triple) {
  const platform = NODE_PLATFORMS[triple];
  if (!platform) throw new Error(`no bundled Node for target ${triple}`);
  const { version, sha256: sums } = PINS.node;
  const windows = platform.startsWith('win');
  const archive = `node-v${version}-${platform}.${windows ? 'zip' : 'tar.gz'}`;
  const out = path.join(BINARIES, `node-${triple}${windows ? '.exe' : ''}`);
  const stamp = `${out}.version`;
  if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, 'utf8') === `${version} ${sums[platform]}`) return out;
  mkdirSync(CACHE, { recursive: true });
  const cached = path.join(CACHE, archive);
  if (!existsSync(cached) || sha256(cached) !== sums[platform]) {
    await download(`https://nodejs.org/dist/v${version}/${archive}`, cached);
  }
  const actual = sha256(cached);
  if (actual !== sums[platform]) {
    rmSync(cached, { force: true });
    throw new Error(`${archive} has SHA-256 ${actual}, expected ${sums[platform]}`);
  }
  const work = mkdtempSync(path.join(tmpdir(), 'geniusbar-node-'));
  try {
    const member = `node-v${version}-${platform}/${windows ? 'node.exe' : 'bin/node'}`;
    execFileSync('tar', ['-xf', cached, '-C', work, member]);
    mkdirSync(BINARIES, { recursive: true });
    cpSync(path.join(work, member), out);
    chmodSync(out, 0o755);
    writeFileSync(stamp, `${version} ${sums[platform]}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return out;
}

export function fetchComponent(name, { repo, ref }) {
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`${name} must be pinned to a full commit SHA`);
  const dest = path.join(RESOURCES, name);
  const stamp = path.join(RESOURCES, `${name}.ref`);
  if (existsSync(dest) && existsSync(stamp) && readFileSync(stamp, 'utf8') === ref) return dest;
  const work = mkdtempSync(path.join(tmpdir(), `geniusbar-${name}-`));
  try {
    const git = (...args) => execFileSync('git', ['-C', work, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
    git('init', '-q');
    git('fetch', '-q', '--depth', '1', `https://github.com/${repo}.git`, ref);
    const tree = path.join(work, 'tree');
    mkdirSync(tree);
    execFileSync('sh', ['-c', 'git -C "$1" archive FETCH_HEAD | tar -x -C "$2"', 'sh', work, tree]);
    const pkg = JSON.parse(readFileSync(path.join(tree, 'package.json'), 'utf8'));
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    const keep = pkg.files
      ? new Set([...pkg.files.map((f) => f.replace(/\/$/, '')), 'package.json', 'LICENSE', 'LICENSE.md'])
      : null;
    for (const entry of execFileSync('ls', ['-A', tree], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
      if (keep ? !keep.has(entry) : EXCLUDED.has(entry)) continue;
      cpSync(path.join(tree, entry), path.join(dest, entry), { recursive: true });
    }
    writeFileSync(stamp, ref);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return dest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const triple = parseTarget(process.argv.slice(2), process.env);
  console.log(`node ${PINS.node.version} -> ${path.relative(ROOT, await fetchNode(triple))}`);
  for (const [name, pin] of Object.entries(PINS.components)) {
    console.log(`${name} ${pin.ref.slice(0, 12)} -> ${path.relative(ROOT, fetchComponent(name, pin))}`);
  }
}
