import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ASIDE, ensurePath, install, pathBlock, pathStatus, profileFor, refresh, removePath, status, uninstall, wrapper, wrapperTarget } from './cli-tools.mjs';

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

test('the script reports one JSON line and takes --replace only for known tools', () => withDirs(({ root, dir, app }) => {
  // A throwaway HOME: install edits the login profile under it, never the developer's own.
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, SHELL: '/bin/zsh', GENIUSBAR_CLI_DIR: '' };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
  let result = run('install', app);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dir, dir);
  assert.deepEqual(states(parsed.tools), { 'agent-bot': 'installed', 'agent-comms': 'installed' });
  assert.deepEqual(parsed.path, { onPath: true, profile: path.join(home, '.zprofile') });
  assert.match(readFileSync(path.join(home, '.zprofile'), 'utf8'), /\$HOME\/\.local\/bin/);
  result = run('uninstall', app);
  assert.deepEqual(JSON.parse(result.stdout).path, { onPath: false, profile: null });
  result = run('install', app, '--replace', '../../etc/passwd');
  assert.equal(result.status, 2);
}));

test('a new terminal is given ~/.local/bin through a marked block in the login profile', () => withDirs(({ root }) => {
  const home = path.join(root, 'home');
  const dir = path.join(home, '.local', 'bin');
  mkdirSync(home, { recursive: true });
  const profile = profileFor('/bin/zsh', home);
  assert.equal(profile, path.join(home, '.zprofile'));
  assert.equal(profileFor('/opt/homebrew/bin/bash', home), path.join(home, '.bash_profile'));
  assert.equal(profileFor('/usr/local/bin/fish', home), null);
  const stock = '/usr/local/bin:/usr/bin:/bin';
  writeFileSync(profile, 'eval "$(/opt/homebrew/bin/brew shellenv)"');
  assert.deepEqual(pathStatus({ dir, home, profile, loginPath: stock }), { onPath: false, profile: null });
  assert.deepEqual(ensurePath({ dir, home, profile, loginPath: stock }), { onPath: true, profile });
  assert.equal(readFileSync(profile, 'utf8'), `eval "$(/opt/homebrew/bin/brew shellenv)"\n${pathBlock(dir, home)}`);
  assert.match(readFileSync(profile, 'utf8'), /^export PATH="\$HOME\/\.local\/bin:\$PATH"$/m);
  // Idempotent, and the block is all uninstall takes out.
  ensurePath({ dir, home, profile, loginPath: stock });
  assert.equal(readFileSync(profile, 'utf8').split('geniusbar-cli-tool').length, 2);
  assert.deepEqual(removePath({ dir, home, profile, loginPath: stock }), { onPath: false, profile: null });
  assert.equal(readFileSync(profile, 'utf8'), 'eval "$(/opt/homebrew/bin/brew shellenv)"\n');
}));

test('a directory already on PATH, or a shell GeniusBar does not edit, leaves profiles alone', () => withDirs(({ root }) => {
  const home = path.join(root, 'home');
  const dir = path.join(home, '.local', 'bin');
  mkdirSync(home, { recursive: true });
  const profile = path.join(home, '.zprofile');
  assert.deepEqual(ensurePath({ dir, home, profile, loginPath: `${dir}:/usr/bin` }), { onPath: true, profile: null });
  assert.deepEqual(ensurePath({ dir, home, profile: null, loginPath: '/usr/bin' }), { onPath: false, profile: null });
  assert.throws(() => readFileSync(profile), /ENOENT/);
  assert.equal(pathBlock('/tmp/odd"dir', home), null);
}));

test('an occupied later aside stops every replacement before anything changes', () => withDirs(({ dir, shims }) => {
  mkdirSync(dir, { recursive: true });
  symlinkSync('/old/agent-bot', path.join(dir, 'agent-bot'));
  symlinkSync('/old/agent-comms', path.join(dir, 'agent-comms'));
  // Even a dangling symlink occupies an aside destination.
  const aside = path.join(dir, `agent-comms${ASIDE}`);
  symlinkSync('/earlier/agent-comms', aside);
  assert.throws(() => install({ dir, shims, replace: ['agent-bot', 'agent-comms'] }), { code: 'tools-aside-exists' });
  assert.equal(readlinkSync(path.join(dir, 'agent-bot')), '/old/agent-bot');
  assert.equal(readlinkSync(path.join(dir, 'agent-comms')), '/old/agent-comms');
  assert.equal(readlinkSync(aside), '/earlier/agent-comms');
  assert.throws(() => lstatSync(path.join(dir, `agent-bot${ASIDE}`)), { code: 'ENOENT' });
}));
