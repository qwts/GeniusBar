import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ASIDE, install, refresh, status, uninstall, wrapper, wrapperTarget } from './cli-tools.mjs';

const script = fileURLToPath(new URL('./cli-tools.mjs', import.meta.url));

function withDirs(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'gb-cli-tools-'));
  // An app path with a space and a quote, as a renamed copy might have.
  const app = path.join(root, "Genius Bar's.app", 'Contents', 'Resources', 'bin');
  mkdirSync(app, { recursive: true });
  const shims = {};
  for (const name of ['agent-bot', 'agent-comms']) {
    shims[name] = path.join(app, name);
    writeFileSync(shims[name], `#!/bin/sh\necho "${name} from the app: $*"\n`, { mode: 0o755 });
  }
  try { return run({ root, dir: path.join(root, 'home', '.local', 'bin'), app, shims }); } finally { rmSync(root, { recursive: true, force: true }); }
}

const states = (tools) => Object.fromEntries(tools.map((tool) => [tool.name, tool.state]));

test('a wrapper names its shim, and only a marked file is read as one', () => {
  const shim = "/Applications/Genius Bar's.app/Contents/Resources/bin/agent-bot";
  assert.equal(wrapperTarget(wrapper(shim)), shim);
  assert.equal(wrapperTarget(`#!/bin/sh\nexec '${shim}' "$@"\n`), null);
});

test('install writes executable wrappers that run the app copy, and uninstall removes them', () => withDirs(({ dir, shims }) => {
  assert.deepEqual(states(status({ dir, shims })), { 'agent-bot': 'absent', 'agent-comms': 'absent' });
  assert.deepEqual(states(install({ dir, shims })), { 'agent-bot': 'installed', 'agent-comms': 'installed' });
  const file = path.join(dir, 'agent-comms');
  assert.equal(statSync(file).mode & 0o777, 0o755);
  const run = spawnSync(file, ['--version'], { encoding: 'utf8' });
  assert.equal(run.stdout, 'agent-comms from the app: --version\n');
  assert.deepEqual(states(install({ dir, shims })), { 'agent-bot': 'installed', 'agent-comms': 'installed' });
  assert.deepEqual(states(uninstall({ dir, shims })), { 'agent-bot': 'absent', 'agent-comms': 'absent' });
}));

test('another copy is a conflict that changes nothing until the user names it', () => withDirs(({ root, dir, shims }) => {
  mkdirSync(dir, { recursive: true });
  const brew = path.join(root, 'opt', 'homebrew', 'opt', 'agent-bot', 'bin', 'agent-bot');
  symlinkSync(brew, path.join(dir, 'agent-bot'));
  assert.deepEqual(status({ dir, shims })[0], { name: 'agent-bot', state: 'other', target: brew });
  assert.throws(() => install({ dir, shims }), (error) => error.code === 'tools-conflict' && error.message.includes(brew));
  // All or nothing: the free tool was not written either.
  assert.deepEqual(states(status({ dir, shims })), { 'agent-bot': 'other', 'agent-comms': 'absent' });

  assert.deepEqual(states(install({ dir, shims, replace: ['agent-bot'] })), { 'agent-bot': 'installed', 'agent-comms': 'installed' });
  assert.equal(readlinkSync(path.join(dir, `agent-bot${ASIDE}`)), brew);
  // Uninstall puts Homebrew's link back exactly as it was.
  uninstall({ dir, shims });
  assert.ok(lstatSync(path.join(dir, 'agent-bot')).isSymbolicLink());
  assert.equal(readlinkSync(path.join(dir, 'agent-bot')), brew);
}));

test('a file GeniusBar did not write is never removed by uninstall', () => withDirs(({ dir, shims }) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'agent-comms'), '#!/bin/sh\nexec /usr/local/bin/agent-comms "$@"\n', { mode: 0o755 });
  uninstall({ dir, shims });
  assert.match(readFileSync(path.join(dir, 'agent-comms'), 'utf8'), /usr\/local/);
}));

test('refresh repoints wrappers after the app moved, and leaves other files alone', () => withDirs(({ root, dir, shims }) => {
  const old = Object.fromEntries(Object.keys(shims).map((name) => [name, path.join(root, 'Old.app', name)]));
  install({ dir, shims: old });
  assert.deepEqual(states(status({ dir, shims })), { 'agent-bot': 'stale', 'agent-comms': 'stale' });
  assert.deepEqual(states(refresh({ dir, shims })), { 'agent-bot': 'installed', 'agent-comms': 'installed' });
  assert.equal(spawnSync(path.join(dir, 'agent-bot'), [], { encoding: 'utf8' }).stdout, 'agent-bot from the app: \n');
}));

test('the script reports one JSON line and takes --replace only for known tools', () => withDirs(({ dir, app }) => {
  const env = { ...process.env, GENIUSBAR_CLI_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
  let result = run('install', app);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dir, dir);
  assert.deepEqual(states(parsed.tools), { 'agent-bot': 'installed', 'agent-comms': 'installed' });
  result = run('install', app, '--replace', '../../etc/passwd');
  assert.equal(result.status, 2);
}));
