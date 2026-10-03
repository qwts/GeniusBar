import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseOutput, runSetup } from './setup.mjs';

test('parses the CLI hint line, JSON, and trailing message', () => {
  assert.deepEqual(parseOutput('Ask the owner: x\n{\n  "ok": true,\n  "code": "AB"\n}\n'), { ok: true, code: 'AB' });
  assert.deepEqual(parseOutput('{"ok":false,"error":{"code":"unpaired"}}\nagent-comms: not paired {sic}'),
    { ok: false, error: { code: 'unpaired' } });
  assert.equal(parseOutput('no json'), null);
});

// A scripted CLI: answers keyed by the joined arguments, in order.
function fakeCli(script) {
  const calls = [];
  const cli = async (args) => {
    const key = args.join(' ');
    calls.push(key);
    const queue = script[key];
    if (!queue?.length) throw new Error(`unexpected: ${key}`);
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  return { cli, calls };
}

const live = { ok: true, pairings: [] };
// A daemon that already runs, paired with the broker.
const readyBot = () => fakeCli({ 'daemon status --json': [{ running: true, comms: { paired: true, connected: true } }] }).cli;
const down = { ok: false, error: { code: 'broker-unreachable' } };

test('fresh machine: installs the broker, pairs and approves both', async () => {
  const { cli, calls } = fakeCli({
    'broker pairings': [down, down, live],
    'broker install': [{ ok: true }],
    'account status': [{ ok: false, error: { code: 'unpaired' } }],
    'account pair': [{ ok: true, account: 'me', code: 'AC1', state: 'pending' }],
    'broker approve AC1': [{ ok: true, state: 'approved' }],
    census: [{ ok: false, error: { code: 'credential-invalid' } }],
    'principal pair --name GeniusBar': [{ ok: true, code: 'PC1', state: 'pending' }],
    'admin principal-approve PC1': [{ ok: true, state: 'approved' }],
  });
  const reports = [];
  await runSetup({ cli, bot: readyBot(), report: (r) => reports.push(r), sleep: async () => {} });
  assert.ok(calls.includes('broker install'));
  assert.deepEqual(reports.filter((r) => r.state === 'done').map((r) => r.step), ['broker', 'account', 'principal', 'daemon']);
});

test('an existing broker is reused, never replaced', async () => {
  const { cli, calls } = fakeCli({
    'broker pairings': [live],
    'account status': [{ ok: true, account: 'me', state: 'approved' }],
    census: [{ ok: true, souls: [] }],
  });
  await runSetup({ cli, bot: readyBot(), report: () => {} });
  assert.deepEqual(calls, ['broker pairings', 'account status', 'census']);
});

test('setup starts agent-bot-keyd beside the daemon, and an older agent-bot never fails it (agent-bot-identity #397)', async () => {
  const keyd = '/Applications/GeniusBar.app/Contents/MacOS/agent-bot-keyd';
  const script = {
    'broker pairings': [live],
    'account status': [{ ok: true, account: 'me', state: 'approved' }],
    census: [{ ok: true, souls: [] }],
  };
  for (const [answer, detail] of [
    [{ label: 'app.geniusbar.keyd', changed: true, loaded: true }, 'agent-bot-keyd is running'],
    [null, 'agent-bot-keyd was not set up'],
  ]) {
    const bot = fakeCli({
      'daemon status --json': [{ running: true, comms: { paired: true, connected: true } }],
      [`keyd install --bin ${keyd} --json`]: [answer],
    });
    const reports = [];
    await runSetup({ cli: fakeCli(script).cli, bot: bot.cli, report: (r) => reports.push(r), keyd });
    assert.deepEqual(bot.calls, ['daemon status --json', `keyd install --bin ${keyd} --json`]);
    assert.ok(reports.some((r) => r.detail === detail));
    assert.equal(reports.at(-1).state, 'done');
  }
});

// #56: on a Mac moved over from Homebrew, the CLI's census answers as the
// owner's principal while GeniusBar has none of its own; setup must pair it.
test('pairs GeniusBar when the CLI answers as another principal but GeniusBar has none', async () => {
  const { cli, calls } = fakeCli({
    'broker pairings': [live],
    'account status': [{ ok: true, account: 'me', state: 'approved' }],
    census: [{ ok: true, souls: [] }],
    'principal pair --name GeniusBar': [{ ok: true, code: 'PC2', state: 'pending' }],
    'admin principal-approve PC2': [{ ok: true, state: 'approved' }],
  });
  const reports = [];
  await runSetup({ cli, bot: readyBot(), report: (r) => reports.push(r),
    principal: async () => ({ ok: false, error: { code: 'keychain-read-failed' } }) });
  assert.deepEqual(calls, ['broker pairings', 'account status', 'principal pair --name GeniusBar', 'admin principal-approve PC2']);
  assert.deepEqual(reports.filter((r) => r.state === 'done').map((r) => r.step), ['broker', 'account', 'principal', 'daemon']);
});

test('a GeniusBar principal that already answers is not paired again', async () => {
  const { cli, calls } = fakeCli({
    'broker pairings': [live],
    'account status': [{ ok: true, account: 'me', state: 'approved' }],
  });
  await runSetup({ cli, bot: readyBot(), report: () => {}, principal: async () => ({ ok: true }) });
  assert.deepEqual(calls, ['broker pairings', 'account status']);
});

test('a pending account is approved with its listed code', async () => {
  const { cli, calls } = fakeCli({
    'account status': [{ ok: true, account: 'me', state: 'pending' }],
    'broker pairings': [{ ok: true, pairings: [{ account: 'other', state: 'pending', code: 'X' }, { account: 'me', state: 'pending', code: 'ME1' }] }],
    'broker approve ME1': [{ ok: true, state: 'approved' }],
    census: [{ ok: true, souls: [] }],
  });
  await runSetup({ cli, bot: readyBot(), report: () => {} });
  assert.ok(calls.includes('broker approve ME1'));
});

test('a revoked account stops setup with its state', async () => {
  const { cli } = fakeCli({ 'broker pairings': [live], 'account status': [{ ok: true, account: 'me', state: 'revoked' }] });
  await assert.rejects(runSetup({ cli, bot: readyBot(), report: () => {} }), { code: 'account-not-approved' });
});

test('a broker that never comes up times out', async () => {
  let t = 0;
  const { cli } = fakeCli({ 'broker pairings': [down], 'broker install': [{ ok: true }] });
  await assert.rejects(runSetup({ cli, bot: readyBot(), report: () => {}, sleep: async () => { t += 1000; }, now: () => t }),
    { code: 'broker-not-ready' });
});

test('a broker that answers with any other error is never reinstalled', async () => {
  const { cli, calls } = fakeCli({ 'broker pairings': [{ ok: false, error: { code: 'broker-untrusted', message: 'custody' } }] });
  await assert.rejects(runSetup({ cli, bot: readyBot(), report: () => {} }), { code: 'broker-untrusted' });
  assert.deepEqual(calls, ['broker pairings']);
});

// End to end with the bundled agent-comms against a throwaway broker, when
// scripts/fetch-components.mjs has run.
const comms = fileURLToPath(new URL('../src-tauri/resources/components/agent-comms', import.meta.url));
// #40: the run is confined to a temp root. HOME points there, and setup sees
// agent-comms through a guard that refuses `broker install`: launchctl always
// loads into the real GUI domain whatever HOME says, so the test waits for its
// own broker to answer instead of letting setup install one.
test('sets up against a real broker', { skip: !existsSync(comms) && 'components not fetched' }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gb-setup-'));
  const realAgents = path.join(homedir(), 'Library', 'LaunchAgents');
  const agentsBefore = existsSync(realAgents) ? readdirSync(realAgents).sort() : [];
  const env = { ...process.env, HOME: path.join(root, 'home'), AGENT_COMMS_NO_KEYCHAIN: '1', XDG_STATE_HOME: path.join(root, 'state'),
    AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'), AGENT_COMMS_LOG_DIR: path.join(root, 'logs'),
    AGENT_COMMS_SERVICE_LABEL: 'test.geniusbar.broker', AGENT_COMMS_CREDENTIAL_NAME: 'test.geniusbar.principal' };
  delete env.AGENT_COMMS_MODE;
  delete env.AGENT_COMMS_BROKER_ACCOUNT;
  mkdirSync(env.HOME);
  // A stub agent-bot reporting a ready daemon: the real one would read and
  // register services in this account's home.
  const bot = path.join(root, 'agent-bot');
  mkdirSync(bot);
  writeFileSync(path.join(bot, 'agent-bot.mjs'), 'console.log(JSON.stringify({ running: true, comms: { paired: true } }));\n');
  const calls = path.join(root, 'comms-calls.log');
  const guard = path.join(root, 'agent-comms');
  mkdirSync(path.join(guard, 'bin'), { recursive: true });
  // setup loads the principal client from the agent-comms it was given (#56).
  symlinkSync(path.join(comms, 'lib'), path.join(guard, 'lib'));
  writeFileSync(path.join(guard, 'package.json'), readFileSync(path.join(comms, 'package.json')));
  writeFileSync(path.join(guard, 'bin', 'agent-comms.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');`,
    "if (process.argv[2] === 'broker' && process.argv[3] === 'install') {",
    "  console.log(JSON.stringify({ ok: false, error: { code: 'test-refused-install', message: 'broker install would load into the real GUI domain' } }));",
    '  process.exit(1);',
    '}',
    `await import(${JSON.stringify(pathToFileURL(path.join(comms, 'bin', 'agent-comms.mjs')).href)});`,
  ].join('\n'));
  const cliBin = path.join(comms, 'bin', 'agent-comms.mjs');
  const broker = spawn(process.execPath, [cliBin, 'broker', 'run'], { env, stdio: 'ignore' });
  try {
    // Wait for the broker itself to answer, not for a fixed time.
    for (let i = 0; ; i += 1) {
      const probe = spawnSync(process.execPath, [cliBin, 'broker', 'pairings'], { env, encoding: 'utf8' });
      if (probe.status === 0) break;
      if (i >= 100) assert.fail('the test broker never answered');
      await new Promise((r) => setTimeout(r, 100));
    }
    const script = fileURLToPath(new URL('./setup.mjs', import.meta.url));
    const out = await new Promise((resolve) => {
      let text = '';
      const child = spawn(process.execPath, [script, guard, bot], { env, stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.on('data', (d) => { text += d; });
      child.on('exit', () => resolve(text));
    });
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.at(-1), { done: true });
    assert.deepEqual(lines.filter((l) => l.state === 'done').map((l) => l.step), ['broker', 'account', 'principal', 'daemon']);
    assert.ok(!readFileSync(calls, 'utf8').split('\n').includes('broker install'), 'setup must reuse the answering broker');
  } finally {
    broker.kill();
    rmSync(root, { recursive: true, force: true });
  }
  // Nothing landed in the real account's LaunchAgents.
  assert.deepEqual(existsSync(realAgents) ? readdirSync(realAgents).sort() : [], agentsBefore);
});

// Broker, account and principal already set up.
const settled = () => fakeCli({
  'broker pairings': [live],
  'account status': [{ ok: true, account: 'me', state: 'approved' }],
  census: [{ ok: true, souls: [] }],
  'broker approve DC1': [{ ok: true, state: 'approved' }],
});

test('no daemon: pairs and approves it, then registers GeniusBar\'s and waits for it', async () => {
  const comms = settled();
  const { cli: bot, calls } = fakeCli({
    'daemon status --json': [{ running: false, reason: 'no daemon state file', comms: { paired: false } },
      { running: false, comms: { paired: true } }, { running: true, comms: { paired: true } }],
    'daemon pair-comms --json': [{ account: 'me', code: 'DC1', state: 'pending' }],
    'daemon install --json': [{ label: 'app.geniusbar.agent-bot', changed: true, loaded: true }],
  });
  const reports = [];
  await runSetup({ cli: comms.cli, bot, report: (r) => reports.push(r), sleep: async () => {} });
  assert.ok(comms.calls.includes('broker approve DC1'));
  assert.deepEqual(calls, ['daemon status --json', 'daemon pair-comms --json', 'daemon install --json',
    'daemon status --json', 'daemon status --json']);
  assert.deepEqual(reports.at(-1), { step: 'daemon', state: 'done' });
});

test('a running daemon is reused; an unpaired one is only paired', async () => {
  const comms = settled();
  const { cli: bot, calls } = fakeCli({
    'daemon status --json': [{ running: true, comms: { paired: false } }],
    'daemon pair-comms --json': [{ account: 'me', code: 'DC1', state: 'pending' }],
  });
  await runSetup({ cli: comms.cli, bot, report: () => {} });
  assert.deepEqual(calls, ['daemon status --json', 'daemon pair-comms --json']);
});

test('daemon failures stop setup with their codes', async () => {
  const unpaired = { running: false, comms: { paired: false } };
  let bot = fakeCli({ 'daemon status --json': [unpaired],
    'daemon pair-comms --json': [{ ok: false, error: { code: 'broker-untrusted', message: 'custody' } }] }).cli;
  await assert.rejects(runSetup({ cli: settled().cli, bot, report: () => {} }), { code: 'broker-untrusted' });
  bot = fakeCli({ 'daemon status --json': [{ running: false, comms: { paired: true } }],
    'daemon install --json': [{ ok: false, error: { code: 'launchagent-load-failed', message: 'no' } }] }).cli;
  await assert.rejects(runSetup({ cli: settled().cli, bot, report: () => {} }), { code: 'launchagent-load-failed' });
  let t = 0;
  bot = fakeCli({ 'daemon status --json': [{ running: false, comms: { paired: true } }],
    'daemon install --json': [{ label: 'x' }] }).cli;
  await assert.rejects(runSetup({ cli: settled().cli, bot, report: () => {}, sleep: async () => { t += 1000; }, now: () => t }),
    { code: 'daemon-not-ready' });
});
