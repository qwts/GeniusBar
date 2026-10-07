// The Windows shims (ADR-0046 decision 5): bin/*.cmd run the bundled
// node.exe or MinGit's git.exe with the component's entry script and the
// caller's arguments, from wherever the app is installed, and carry the
// command-line tool marker as a REM comment so the owner's tools on Windows
// can be told from anything else.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MARKER } from '../bridge/cli-tools.mjs';

const BIN = new URL('../bin/', import.meta.url);
const MARKER_WORD = MARKER.replace(/^#\s*/, '');

// Each shim's one command line: the executable and the entry script,
// relative to the shim, then the caller's arguments.
const SHIMS = {
  'agent-bot.cmd': '"%~dp0..\\node.exe" "%~dp0..\\components\\agent-bot\\agent-bot.mjs" %*',
  'agent-comms.cmd': '"%~dp0..\\node.exe" "%~dp0..\\components\\agent-comms\\bin\\agent-comms.mjs" %*',
  'node.cmd': '"%~dp0..\\node.exe" %*',
  'git.cmd': '"%~dp0..\\git\\cmd\\git.exe" %*',
};

test('every sh shim has a .cmd twin, and nothing else is a .cmd', () => {
  const names = readdirSync(BIN);
  const cmds = names.filter((name) => name.endsWith('.cmd')).sort();
  const shims = names.filter((name) => !name.endsWith('.cmd')).map((name) => `${name}.cmd`).sort();
  assert.deepEqual(cmds, shims);
  assert.deepEqual(cmds, Object.keys(SHIMS).sort());
});

test('each .cmd shim is echo off, the marker as a REM comment, and one command line with %*', () => {
  for (const [name, command] of Object.entries(SHIMS)) {
    const text = readFileSync(new URL(name, BIN), 'utf8');
    // cmd.exe is only reliable with its own line endings (.gitattributes keeps them).
    assert.ok(text.endsWith('\r\n'), `${name} ends with CRLF`);
    assert.equal(text.includes('\n'), true);
    assert.equal(text.replaceAll('\r\n', '').includes('\n'), false, `${name} uses CRLF only`);
    const lines = text.split('\r\n').filter(Boolean);
    assert.equal(lines[0], '@echo off', name);
    assert.ok(lines[1].startsWith(`REM ${MARKER_WORD}`), `${name} carries the marker`);
    assert.deepEqual(lines.slice(2), [command], name);
  }
});

test('the .cmd shims reach the same component entry points as the sh shims', () => {
  for (const name of ['agent-bot', 'agent-comms']) {
    const sh = readFileSync(new URL(name, BIN), 'utf8');
    const entry = sh.match(/components\/([\w./-]+\.mjs)/)[1];
    assert.ok(SHIMS[`${name}.cmd`].includes(`components\\${entry.replaceAll('/', '\\')}`), `${name}.cmd runs ${entry}`);
  }
});
