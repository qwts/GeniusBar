import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
  await runSetup({ cli, report: (r) => reports.push(r), sleep: async () => {} });
  assert.ok(calls.includes('broker install'));
  assert.deepEqual(reports.filter((r) => r.state === 'done').map((r) => r.step), ['broker', 'account', 'principal']);
});

test('an existing broker is reused, never replaced', async () => {
  const { cli, calls } = fakeCli({
    'broker pairings': [live],
    'account status': [{ ok: true, account: 'me', state: 'approved' }],
    census: [{ ok: true, souls: [] }],
  });
  await runSetup({ cli, report: () => {} });
  assert.deepEqual(calls, ['broker pairings', 'account status', 'census']);
});

test('a pending account is approved with its listed code', async () => {
  const { cli, calls } = fakeCli({
    'account status': [{ ok: true, account: 'me', state: 'pending' }],
    'broker pairings': [{ ok: true, pairings: [{ account: 'other', state: 'pending', code: 'X' }, { account: 'me', state: 'pending', code: 'ME1' }] }],
    'broker approve ME1': [{ ok: true, state: 'approved' }],
    census: [{ ok: true, souls: [] }],
  });
  await runSetup({ cli, report: () => {} });
  assert.ok(calls.includes('broker approve ME1'));
});

test('a revoked account stops setup with its state', async () => {
  const { cli } = fakeCli({ 'broker pairings': [live], 'account status': [{ ok: true, account: 'me', state: 'revoked' }] });
  await assert.rejects(runSetup({ cli, report: () => {} }), { code: 'account-not-approved' });
});

test('a broker that never comes up times out', async () => {
  let t = 0;
  const { cli } = fakeCli({ 'broker pairings': [down], 'broker install': [{ ok: true }] });
  await assert.rejects(runSetup({ cli, report: () => {}, sleep: async () => { t += 1000; }, now: () => t }),
    { code: 'broker-not-ready' });
});

test('a broker that answers with any other error is never reinstalled', async () => {
  const { cli, calls } = fakeCli({ 'broker pairings': [{ ok: false, error: { code: 'broker-untrusted', message: 'custody' } }] });
  await assert.rejects(runSetup({ cli, report: () => {} }), { code: 'broker-untrusted' });
  assert.deepEqual(calls, ['broker pairings']);
});

// End to end with the bundled agent-comms against a throwaway broker, when
// scripts/fetch-components.mjs has run.
const comms = fileURLToPath(new URL('../src-tauri/resources/components/agent-comms', import.meta.url));
test('sets up against a real broker', { skip: !existsSync(comms) && 'components not fetched' }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gb-setup-'));
  const env = { ...process.env, AGENT_COMMS_NO_KEYCHAIN: '1', XDG_STATE_HOME: path.join(root, 'state'),
    AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'), AGENT_COMMS_LOG_DIR: path.join(root, 'logs'),
    AGENT_COMMS_SERVICE_LABEL: 'test.geniusbar.broker', AGENT_COMMS_CREDENTIAL_NAME: 'test.geniusbar.principal' };
  delete env.AGENT_COMMS_MODE;
  delete env.AGENT_COMMS_BROKER_ACCOUNT;
  const broker = spawn(process.execPath, [path.join(comms, 'bin', 'agent-comms.mjs'), 'broker', 'run'], { env, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const script = fileURLToPath(new URL('./setup.mjs', import.meta.url));
    const out = await new Promise((resolve) => {
      let text = '';
      const child = spawn(process.execPath, [script, comms], { env, stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.on('data', (d) => { text += d; });
      child.on('exit', () => resolve(text));
    });
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.at(-1), { done: true });
    assert.deepEqual(lines.filter((l) => l.state === 'done').map((l) => l.step), ['broker', 'account', 'principal']);
  } finally {
    broker.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
