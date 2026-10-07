#!/usr/bin/env node
// Builds the git GeniusBar bundles (#102), so a new Mac needs no Command
// Line Tools install: soul homes are git worktrees and Claude Code runs git,
// and a stock Mac's /usr/bin/git is only a stub that asks to install them.
//
// The source is the kernel.org tarball pinned in components.json (version
// and SHA-256), built relocatable and without git's optional parts (no
// gettext, Perl, Python, Tcl/Tk, Expat or its Rust library), one slice per
// architecture joined with lipo: a two-arch CFLAGS build leaves objects out
// of the x86_64 slice. Only what a soul runs is kept: `git` itself and the
// https remote helper become Tauri sidecars (src-tauri/binaries/git-<triple>
// and git-remote-https-<triple>), signed with the app like node and keyd;
// the init templates go to src-tauri/resources/git-templates. The bin/git
// shim points git at them with GIT_EXEC_PATH and GIT_TEMPLATE_DIR.
//
// usage: node scripts/build-git.mjs [--target RUST_TRIPLE]
// The target comes from --target, then TAURI_ENV_TARGET_TRIPLE, then the
// host, as build-keyd.mjs. A build is kept under .cache/git/<version> and
// reused while the pin and the stamp agree.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIVERSAL_TARGETS } from './fetch-components.mjs';
import { parseTarget } from './build-keyd.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PINS = JSON.parse(readFileSync(path.join(ROOT, 'components.json'), 'utf8'));
const CACHE = path.join(ROOT, '.cache', 'git');
const BINARIES = path.join(ROOT, 'src-tauri', 'binaries');
const TEMPLATES = path.join(ROOT, 'src-tauri', 'resources', 'git-templates');
const MIRROR = 'https://mirrors.edge.kernel.org/pub/software/scm/git';

/** The sidecars Tauri bundles for `triple`: what a soul runs, nothing else. */
export const SIDECARS = ['git', 'git-remote-https'];

export function gitSidecarName(name, triple) {
  return `${name}-${triple}`;
}

/** The Make settings for one slice: relocatable, no optional parts. */
export function makeArguments(arch, destdir) {
  return [
    `-j${Number(process.env.GENIUSBAR_GIT_JOBS) || 8}`,
    'prefix=/',
    'RUNTIME_PREFIX=YesPlease',
    'NO_GETTEXT=1', 'NO_TCLTK=1', 'NO_PERL=1', 'NO_PYTHON=1', 'NO_EXPAT=1', 'NO_GITWEB=1', 'NO_RUST=1',
    'NO_INSTALL_HARDLINKS=1', 'SKIP_DASHED_BUILT_INS=1',
    `CFLAGS=-O2 -arch ${arch}`,
    `LDFLAGS=-arch ${arch}`,
    `DESTDIR=${destdir}`,
    'install',
  ];
}

/** The architecture flag for a darwin triple. */
export function archOf(triple) {
  const arch = { 'aarch64-apple-darwin': 'arm64', 'x86_64-apple-darwin': 'x86_64' }[triple];
  if (!arch) throw new Error(`git builds only for macOS targets, not ${triple}`);
  return arch;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** The pinned tarball, downloaded once and verified every time. */
export async function fetchTarball({ version, sha256: want } = PINS.git, { cache = CACHE, fetchFn = fetch } = {}) {
  const archive = `git-${version}.tar.xz`;
  const cached = path.join(cache, archive);
  mkdirSync(cache, { recursive: true });
  if (!existsSync(cached) || sha256(cached) !== want) {
    const response = await fetchFn(`${MIRROR}/${archive}`);
    if (!response.ok) throw new Error(`${archive}: ${response.status}`);
    writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
  }
  const actual = sha256(cached);
  if (actual !== want) {
    rmSync(cached, { force: true });
    throw new Error(`${archive} has SHA-256 ${actual}, expected ${want}`);
  }
  return cached;
}

/** Unpacks and builds one slice into `<cache>/<version>/<arch>`; the install tree. */
function buildSlice(tarball, version, triple, { cache = CACHE } = {}) {
  const arch = archOf(triple);
  const work = path.join(cache, version, arch);
  const out = path.join(work, 'out');
  if (existsSync(path.join(out, 'bin', 'git'))) return out;
  rmSync(work, { recursive: true, force: true });
  const src = path.join(work, 'src');
  mkdirSync(src, { recursive: true });
  execFileSync('tar', ['-xJf', tarball, '-C', src, '--strip-components=1']);
  execFileSync('make', makeArguments(arch, out), { cwd: src, stdio: ['ignore', 'ignore', 'inherit'] });
  rmSync(src, { recursive: true, force: true });
  return out;
}

/** Where a sidecar sits in a slice's install tree. */
export function sliceFile(out, name) {
  return name === 'git' ? path.join(out, 'bin', 'git') : path.join(out, 'libexec', 'git-core', 'git-remote-http');
}

/**
 * Builds the git sidecars and templates for `triple`. As build-keyd.mjs, a
 * universal build leaves each slice's sidecars beside the lipo'd ones. The
 * https helper is git's http helper under the name git looks up for an
 * https URL (the same binary serves every curl protocol).
 */
export function buildGit(triple, {
  build = buildSlice, copy = copyFileSync, lipo = (args) => execFileSync('lipo', args),
  binaries = BINARIES, templates = TEMPLATES, pins = PINS.git, tarball,
} = {}) {
  if (!triple.endsWith('-apple-darwin')) throw new Error(`git builds only for macOS targets, not ${triple}`);
  const stamp = path.join(binaries, `git-${triple}.version`);
  const want = `${pins.version} ${pins.sha256}`;
  const outputs = SIDECARS.map((name) => path.join(binaries, gitSidecarName(name, triple)));
  if (outputs.every(existsSync) && existsSync(path.join(templates, 'info')) && existsSync(stamp) && readFileSync(stamp, 'utf8') === want) {
    return outputs;
  }
  mkdirSync(binaries, { recursive: true });
  const parts = UNIVERSAL_TARGETS[triple] ?? [triple];
  const slices = parts.map((part) => build(tarball, pins.version, part));
  for (const name of SIDECARS) {
    const out = path.join(binaries, gitSidecarName(name, triple));
    if (parts.length === 1) {
      copy(sliceFile(slices[0], name), out);
    } else {
      parts.forEach((part, i) => copy(sliceFile(slices[i], name), path.join(binaries, gitSidecarName(name, part))));
      lipo(['-create', ...slices.map((slice) => sliceFile(slice, name)), '-output', out]);
    }
  }
  rmSync(templates, { recursive: true, force: true });
  cpSync(path.join(slices[0], 'share', 'git-core', 'templates'), templates, { recursive: true });
  writeFileSync(stamp, want);
  return outputs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const triple = parseTarget(process.argv.slice(2), process.env);
  const tarball = await fetchTarball();
  const outputs = buildGit(triple, { tarball });
  process.stdout.write(`git ${PINS.git.version}: ${outputs.map((out) => path.relative(ROOT, out)).join(', ')}\n`);
}
