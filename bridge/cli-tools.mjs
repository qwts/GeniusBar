#!/usr/bin/env node
// Command-line tools (#41): put the bundled agent-bot and agent-comms on the
// user's PATH, the way VS Code installs its `code` command, so an agent that
// GeniusBar did not launch can join without a second copy from Homebrew.
//
// Each tool is a small wrapper script in a user directory (~/.local/bin), not
// a symlink: the bundled shims find Node relative to themselves. A wrapper
// execs the shim inside the app, so an in-app update is picked up with no
// reinstall. A marker line identifies GeniusBar's wrappers; nothing else is
// ever removed.
//
//   status     what is at each tool's path now
//   install    write the wrappers. A tool path that holds something else
//              (Homebrew's link, say) is a conflict and is left alone unless
//              it is named with --replace, after the user confirmed. A
//              replaced entry is moved aside, and uninstall puts it back.
//   uninstall  remove GeniusBar's wrappers and restore what they replaced
//   refresh    at app start: rewrite GeniusBar's wrappers if the app moved
//
// Result: one JSON line, {ok: true, dir, tools: [{name, state, target?}]}
// with state 'absent' | 'installed' | 'stale' | 'other', or
// {ok: false, code, message}. Never needs admin rights.
//
// usage: node cli-tools.mjs status|install|uninstall|refresh TOOL_DIR [--replace NAME]...

import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const TOOLS = ['agent-bot', 'agent-comms'];
export const MARKER = '# geniusbar-cli-tool';
export const ASIDE = '.before-geniusbar';

export class ToolsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

/** The wrapper for one tool: execs the app's shim, wherever the app is. */
export function wrapper(shim) {
  return `#!/bin/sh\n${MARKER}: written by GeniusBar. "Uninstall command-line tools" removes it.\nexec ${quote(shim)} "$@"\n`;
}

/** The shim a GeniusBar wrapper execs, or null for anything else. */
export function wrapperTarget(text) {
  if (!text.split('\n').some((line) => line.startsWith(MARKER))) return null;
  const exec = text.split('\n').find((line) => line.startsWith('exec '));
  const match = exec?.match(/^exec '((?:[^']|'\\'')*)' "\$@"$/);
  return match ? match[1].replaceAll(`'\\''`, "'") : null;
}

function lstat(file) {
  try { return lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** What sits at one tool path: ours (current or stale), someone else's, or nothing. */
export function inspectTool(dir, name, shim) {
  const file = path.join(dir, name);
  const stat = lstat(file);
  if (!stat) return { name, state: 'absent' };
  if (stat.isSymbolicLink()) return { name, state: 'other', target: readlinkSync(file) };
  if (!stat.isFile()) return { name, state: 'other', target: file };
  let target = null;
  // Only a small file can be a wrapper; never read a large binary whole.
  if (stat.size < 4096) target = wrapperTarget(readFileSync(file, 'utf8'));
  if (target === null) return { name, state: 'other', target: file };
  return { name, state: target === shim ? 'installed' : 'stale', target };
}

export function status({ dir, shims }) {
  return TOOLS.map((name) => inspectTool(dir, name, shims[name]));
}

function writeWrapper(dir, name, shim) {
  const file = path.join(dir, name);
  const temp = `${file}.geniusbar-${process.pid}.tmp`;
  try {
    writeFileSync(temp, wrapper(shim), { mode: 0o755, flag: 'wx' });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Writes every wrapper it may. A conflict not named in `replace` stops the
 * whole install before anything is written, so the result is all or nothing.
 */
export function install({ dir, shims, replace = [] }) {
  const before = status({ dir, shims });
  const conflicts = before.filter((tool) => tool.state === 'other' && !replace.includes(tool.name));
  if (conflicts.length) {
    const list = conflicts.map((tool) => `${tool.name} (${tool.target})`).join(', ');
    throw new ToolsError('tools-conflict', `already on PATH: ${list}`);
  }
  mkdirSync(dir, { recursive: true });
  for (const tool of before) {
    if (tool.state === 'installed') continue;
    if (tool.state === 'other') {
      const aside = path.join(dir, `${tool.name}${ASIDE}`);
      if (lstat(aside)) throw new ToolsError('tools-aside-exists', `${aside} already exists; move it before replacing ${tool.name}`);
      renameSync(path.join(dir, tool.name), aside);
    }
    writeWrapper(dir, tool.name, shims[tool.name]);
  }
  return status({ dir, shims });
}

/** Removes only GeniusBar's wrappers, and restores what each one replaced. */
export function uninstall({ dir, shims }) {
  for (const tool of status({ dir, shims })) {
    if (tool.state !== 'installed' && tool.state !== 'stale') continue;
    const file = path.join(dir, tool.name);
    rmSync(file);
    const aside = path.join(dir, `${tool.name}${ASIDE}`);
    if (lstat(aside)) renameSync(aside, file);
  }
  return status({ dir, shims });
}

/** Points GeniusBar's own wrappers at this copy of the app; touches nothing else. */
export function refresh({ dir, shims }) {
  for (const tool of status({ dir, shims })) {
    if (tool.state === 'stale') writeWrapper(dir, tool.name, shims[tool.name]);
  }
  return status({ dir, shims });
}

const ACTIONS = { status, install, uninstall, refresh };

async function main() {
  const [action, toolDir, ...rest] = process.argv.slice(2);
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const replace = [];
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] !== '--replace' || !TOOLS.includes(rest[i + 1])) {
      process.stderr.write('usage: cli-tools.mjs status|install|uninstall|refresh TOOL_DIR [--replace NAME]...\n');
      process.exit(2);
    }
    replace.push(rest[i + 1]);
  }
  if (!ACTIONS[action] || !toolDir) {
    process.stderr.write('usage: cli-tools.mjs status|install|uninstall|refresh TOOL_DIR [--replace NAME]...\n');
    process.exit(2);
  }
  const dir = process.env.GENIUSBAR_CLI_DIR || path.join(os.homedir(), '.local', 'bin');
  const shims = Object.fromEntries(TOOLS.map((name) => [name, path.join(path.resolve(toolDir), name)]));
  try {
    write({ ok: true, dir, tools: ACTIONS[action]({ dir, shims, replace }) });
  } catch (error) {
    write({ ok: false, code: error.code ?? 'tools-failed', message: String(error.message ?? error) });
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
