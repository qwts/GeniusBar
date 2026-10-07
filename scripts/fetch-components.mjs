#!/usr/bin/env node
// Fetches what GeniusBar bundles (ADR-0004 decision 3), pinned in
// components.json: the official Node binary, verified by SHA-256, becomes the
// Tauri sidecar; agent-comms and agent-bot, fetched by commit so git verifies
// their content, become app resources. Nothing here uses a Node or a package
// the user installed. Each component names its release tag and the commit
// that tag must resolve to, so a moved tag fails the build.
//
// usage: node scripts/fetch-components.mjs [--target RUST_TRIPLE]
// Tauri sets TAURI_ENV_TARGET_TRIPLE for its before-build commands. For
// universal-apple-darwin, both darwin binaries are fetched and verified, then
// joined with lipo into the one sidecar Tauri looks for under that triple. A
// Windows target (ADR-0046 decision 8) takes Node's win-x64 zip, which has
// node.exe at its root rather than under bin/, and lands it as the `.exe`
// sidecar; the fetcher runs on a Windows host too, where tar reads zips.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// A target built from several per-architecture Node binaries.
export const UNIVERSAL_TARGETS = {
  'universal-apple-darwin': ['aarch64-apple-darwin', 'x86_64-apple-darwin'],
};

// The sidecar path Tauri expects for a target: `<externalBin>-<triple>`.
export function sidecarName(triple) {
  return `node-${triple}${triple.endsWith('-windows-msvc') ? '.exe' : ''}`;
}

// What a sidecar's .version stamp records, so a pin change refetches it.
// A universal stamp covers every slice, so changing either checksum rebuilds.
export function stampFor(triple, pins = PINS.node) {
  const parts = UNIVERSAL_TARGETS[triple] ?? [triple];
  const sums = parts.map((part) => {
    const platform = NODE_PLATFORMS[part];
    if (!platform) throw new Error(`no bundled Node for target ${part}`);
    return pins.sha256[platform];
  });
  return `${pins.version} ${sums.join(' ')}`;
}

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

async function download(url, file, fetchFn = fetch) {
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

/** The official archive name for a platform: Windows ships a zip, the rest tarballs. */
export function nodeArchiveName(platform, version = PINS.node.version) {
  return `node-v${version}-${platform}.${platform.startsWith('win') ? 'zip' : 'tar.gz'}`;
}

/**
 * The official Node archive for a platform, downloaded once into the cache
 * and verified against its pinned SHA-256 every time it is used. A cached
 * file that no longer matches is fetched again; a download that does not
 * match is dropped so the next run does not trust it either.
 */
export async function nodeArchive(platform, { pins = PINS.node, cache = CACHE, fetchFn = fetch } = {}) {
  const { version, sha256: sums } = pins;
  const archive = nodeArchiveName(platform, version);
  mkdirSync(cache, { recursive: true });
  const cached = path.join(cache, archive);
  if (!existsSync(cached) || sha256(cached) !== sums[platform]) {
    await download(`https://nodejs.org/dist/v${version}/${archive}`, cached, fetchFn);
  }
  const actual = sha256(cached);
  if (actual !== sums[platform]) {
    rmSync(cached, { force: true });
    throw new Error(`${archive} has SHA-256 ${actual}, expected ${sums[platform]}`);
  }
  return cached;
}

/** Where `node` or `npm` sits inside a platform's Node archive. */
export function nodeMember(platform, what, version = PINS.node.version) {
  const windows = platform.startsWith('win');
  const file = what === 'node' ? (windows ? 'node.exe' : 'bin/node') : `${windows ? '' : 'lib/'}node_modules/npm`;
  return `node-v${version}-${platform}/${file}`;
}

/** The tar that reads every archive we fetch, zips included: Windows' own
 * bsdtar by its full path, since a Git for Windows GNU tar earlier on PATH
 * takes `D:\...` for a remote host ("Cannot connect to D:"). */
export function tarCommand(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return 'tar';
  return path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

/**
 * Unpacks `members` of an archive (all of it when none are named) into
 * `dest`. tar reads every archive we fetch, zips included, except on macOS
 * and Linux where GNU or an older bsdtar may not, so a zip goes through
 * unzip there. A directory member brings its contents along in both tools.
 */
export function extractArchive(archive, dest, members = []) {
  if (archive.endsWith('.zip') && process.platform !== 'win32') {
    execFileSync('unzip', ['-q', archive, ...members.map((member) => `${member}*`), '-d', dest]);
  } else {
    execFileSync(tarCommand(), ['-xf', archive, '-C', dest, ...members]);
  }
}

/**
 * The npm that ships inside the pinned Node, as a resource next to the
 * other components (#307): hosts install a soul's harnesses with it, so no
 * npm the user installed is ever needed. npm is plain JavaScript, so a
 * universal build takes it from its first slice.
 */
export async function fetchNpm(triple, { pins = PINS.node, cache = CACHE, resources = RESOURCES, fetchFn = fetch } = {}) {
  const platform = NODE_PLATFORMS[(UNIVERSAL_TARGETS[triple] ?? [triple])[0]];
  if (!platform) throw new Error(`no bundled Node for target ${triple}`);
  const dest = path.join(resources, 'npm');
  const stamp = path.join(resources, 'npm.version');
  if (existsSync(dest) && existsSync(stamp) && readFileSync(stamp, 'utf8') === pins.version) return dest;
  const cached = await nodeArchive(platform, { pins, cache, fetchFn });
  const work = mkdtempSync(path.join(tmpdir(), 'geniusbar-npm-'));
  try {
    const member = nodeMember(platform, 'npm', pins.version);
    extractArchive(cached, work, [member]);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(resources, { recursive: true });
    cpSync(path.join(work, member), dest, { recursive: true, verbatimSymlinks: true });
    writeFileSync(stamp, pins.version);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return dest;
}

export async function fetchNode(triple, { pins = PINS.node, cache = CACHE, binaries = BINARIES, fetchFn = fetch } = {}) {
  if (UNIVERSAL_TARGETS[triple]) return fetchUniversalNode(triple, { pins, cache, binaries, fetchFn });
  const platform = NODE_PLATFORMS[triple];
  if (!platform) throw new Error(`no bundled Node for target ${triple}`);
  const out = path.join(binaries, sidecarName(triple));
  const stamp = `${out}.version`;
  if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, 'utf8') === stampFor(triple, pins)) return out;
  const cached = await nodeArchive(platform, { pins, cache, fetchFn });
  const work = mkdtempSync(path.join(tmpdir(), 'geniusbar-node-'));
  try {
    const member = nodeMember(platform, 'node', pins.version);
    extractArchive(cached, work, [member]);
    mkdirSync(binaries, { recursive: true });
    cpSync(path.join(work, member), out);
    chmodSync(out, 0o755);
    writeFileSync(stamp, stampFor(triple, pins));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return out;
}

async function fetchUniversalNode(triple, options) {
  const { pins, binaries } = options;
  const out = path.join(binaries, sidecarName(triple));
  const stamp = `${out}.version`;
  if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, 'utf8') === stampFor(triple, pins)) return out;
  // Each slice is checksum-verified by fetchNode before lipo sees it.
  const slices = [];
  for (const part of UNIVERSAL_TARGETS[triple]) slices.push(await fetchNode(part, options));
  execFileSync('lipo', ['-create', ...slices, '-output', out]);
  chmodSync(out, 0o755);
  writeFileSync(stamp, stampFor(triple, pins));
  return out;
}

export function tagCommit(lsRemote, tag) {
  // An annotated tag lists its commit as `tag^{}`; a lightweight tag is the commit.
  const lines = lsRemote.split('\n').map((line) => line.split('\t'));
  const peeled = lines.find(([, name]) => name === `refs/tags/${tag}^{}`);
  const plain = lines.find(([, name]) => name === `refs/tags/${tag}`);
  return (peeled ?? plain)?.[0] ?? null;
}

/** The entries of a component's tree that ship: its package "files", or everything but the development paths. */
export function shippedEntries(entries, pkg) {
  const keep = pkg.files
    ? new Set([...pkg.files.map((f) => f.replace(/\/$/, '')), 'package.json', 'LICENSE', 'LICENSE.md'])
    : null;
  return entries.filter((entry) => (keep ? keep.has(entry) : !EXCLUDED.has(entry)));
}

export function fetchComponent(name, { repo, tag, ref }) {
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`${name} must be pinned to a full commit SHA`);
  if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`${name} must name a release tag`);
  const dest = path.join(RESOURCES, name);
  const stamp = path.join(RESOURCES, `${name}.ref`);
  if (existsSync(dest) && existsSync(stamp) && readFileSync(stamp, 'utf8') === ref) return dest;
  const work = mkdtempSync(path.join(tmpdir(), `geniusbar-${name}-`));
  try {
    const git = (...args) => execFileSync('git', ['-C', work, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
    git('init', '-q');
    const listed = tagCommit(git('ls-remote', `https://github.com/${repo}.git`, `refs/tags/${tag}*`).toString(), tag);
    if (listed !== ref) throw new Error(`${name} ${tag} resolves to ${listed ?? 'nothing'}, expected ${ref}`);
    git('fetch', '-q', '--depth', '1', `https://github.com/${repo}.git`, ref);
    // Through a tar file rather than a shell pipeline, so a Windows host
    // needs no sh beside git and tar.
    const tree = path.join(work, 'tree');
    const archive = path.join(work, 'tree.tar');
    mkdirSync(tree);
    git('archive', '--format=tar', '-o', archive, 'FETCH_HEAD');
    extractArchive(archive, tree);
    const pkg = JSON.parse(readFileSync(path.join(tree, 'package.json'), 'utf8'));
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    for (const entry of shippedEntries(readdirSync(tree), pkg)) {
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
  console.log(`npm (node ${PINS.node.version}) -> ${path.relative(ROOT, await fetchNpm(triple))}`);
  for (const [name, pin] of Object.entries(PINS.components)) {
    console.log(`${name} ${pin.tag} (${pin.ref.slice(0, 12)}) -> ${path.relative(ROOT, fetchComponent(name, pin))}`);
  }
}
