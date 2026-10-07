import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AUDIT_EXPORT_MAX, createBridge, METHODS } from './bridge.mjs';

function harness(client) {
  const out = [];
  let loads = 0;
  const handle = createBridge({
    loadClient: () => { loads += 1; if (client instanceof Error) throw client; return client; },
    write: (text) => out.push(JSON.parse(text)),
  });
  return { handle, out, loads: () => loads };
}

test('exposes only the principal operations', () => {
  assert.deepEqual(Object.keys(METHODS).sort(), ['ack', 'auditExport', 'census', 'inbox', 'launch', 'launchStatus', 'send']);
});

test('answers a request with its id and result', async () => {
  const h = harness({ census: async () => ({ ok: true, souls: [] }) });
  await h.handle(JSON.stringify({ id: 7, method: 'census' }));
  assert.deepEqual(h.out, [{ id: 7, ok: true, result: { ok: true, souls: [] } }]);
});

test('passes only known fields to the client', async () => {
  let seen;
  const h = harness({ send: async (args) => { seen = args; return { ok: true }; } });
  await h.handle(JSON.stringify({ id: 1, method: 'send', params: { to: 'a/b', body: 'hi', key: 'k', auth: 'x', op: 'admin' } }));
  assert.deepEqual(Object.keys(seen).filter((k) => seen[k] !== undefined).sort(), ['body', 'key', 'to']);
});

test('launch forwards the agent comms choice and nothing else extra (#71)', async () => {
  let seen;
  const h = harness({ launch: async (args) => { seen = args; return { requestId: 'r', status: 'pending' }; } });
  await h.handle(JSON.stringify({ id: 1, method: 'launch',
    params: { account: 'me', package: '/p.soul', harness: 'claude', comms: false, op: 'admin' } }));
  assert.deepEqual(Object.fromEntries(Object.entries(seen).filter(([, v]) => v !== undefined)),
    { account: 'me', package: '/p.soul', harness: 'claude', comms: false });
});

test('launch forwards a chosen model and sends no model key without one (#128)', async () => {
  const seen = [];
  const h = harness({ launch: async (args) => { seen.push(args); return { requestId: 'r', status: 'pending' }; } });
  await h.handle(JSON.stringify({ id: 1, method: 'launch', params: { account: 'me', soul: 'agent_1', harness: 'claude', model: 'claude-opus-4-1' } }));
  await h.handle(JSON.stringify({ id: 2, method: 'launch', params: { account: 'me', soul: 'agent_1', harness: 'claude' } }));
  assert.equal(seen[0].model, 'claude-opus-4-1');
  assert.equal('model' in seen[1], false);
});

test('launch forwards a string brief and drops any other brief (#120)', async () => {
  const seen = [];
  const h = harness({ launch: async (args) => { seen.push(args); return { requestId: 'r', status: 'pending' }; } });
  await h.handle(JSON.stringify({ id: 1, method: 'launch', params: { account: 'me', package: '/p.soul', harness: 'claude', brief: 'Line one\nline two' } }));
  await h.handle(JSON.stringify({ id: 2, method: 'launch', params: { account: 'me', soul: 'agent_1', harness: 'claude' } }));
  await h.handle(JSON.stringify({ id: 3, method: 'launch', params: { account: 'me', soul: 'agent_1', harness: 'claude', brief: { op: 'admin' } } }));
  assert.equal(seen[0].brief, 'Line one\nline two');
  assert.equal('brief' in seen[1], false);
  assert.equal('brief' in seen[2], false);
});

test('launch forwards a string role and drops any other role (agent-bot-identity#535)', async () => {
  const seen = [];
  const h = harness({ launch: async (args) => { seen.push(args); return { requestId: 'r', status: 'pending' }; } });
  await h.handle(JSON.stringify({ id: 1, method: 'launch', params: { account: 'me', package: '/p.soul', harness: 'claude', role: 'Researcher' } }));
  await h.handle(JSON.stringify({ id: 2, method: 'launch', params: { account: 'me', soul: 'agent_1', harness: 'claude' } }));
  await h.handle(JSON.stringify({ id: 3, method: 'launch', params: { account: 'me', package: '/p.soul', harness: 'claude', role: 7 } }));
  assert.equal(seen[0].role, 'Researcher');
  assert.equal('role' in seen[1], false);
  assert.equal('role' in seen[2], false);
});

test('rejects malformed and unknown requests without calling the client', async () => {
  const h = harness({ census: async () => assert.fail('called') });
  await h.handle('not json');
  await h.handle(JSON.stringify({ id: 2, method: 'constructor' }));
  await h.handle(JSON.stringify({ id: 'x', method: 'census' }));
  assert.deepEqual(h.out.map((r) => [r.id, r.error.code]), [[null, 'bad-request'], [2, 'bad-request'], [null, 'bad-request']]);
  assert.equal(h.loads(), 0);
});

test('reports client errors by code and reloads the client after credential errors', async () => {
  const failure = Object.assign(new Error('not paired'), { code: 'credential-invalid' });
  const h = harness(failure);
  await h.handle(JSON.stringify({ id: 3, method: 'census' }));
  await h.handle(JSON.stringify({ id: 4, method: 'census' }));
  assert.deepEqual(h.out.map((r) => r.error.code), ['credential-invalid', 'credential-invalid']);
  assert.equal(h.loads(), 2);
});

test('keeps the client across ordinary errors', async () => {
  const h = harness({ census: async () => { throw Object.assign(new Error('down'), { code: 'broker-unreachable' }); } });
  await h.handle(JSON.stringify({ id: 5, method: 'census' }));
  await h.handle(JSON.stringify({ id: 6, method: 'census' }));
  assert.equal(h.loads(), 1);
});

test('the script serves requests over stdio with a given agent-comms', async () => {
  const comms = mkdtempSync(path.join(tmpdir(), 'bridge-comms-'));
  mkdirSync(path.join(comms, 'lib'));
  writeFileSync(path.join(comms, 'lib', 'principal-client.mjs'),
    'export const createPrincipalClient = () => ({ census: async () => ({ ok: true, souls: [{ agentId: "agent_1" }] }) });\n');
  const script = fileURLToPath(new URL('./bridge.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, comms], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.write(`${JSON.stringify({ id: 1, method: 'census' })}\n`);
  const line = await new Promise((resolve) => child.stdout.once('data', (chunk) => resolve(String(chunk))));
  child.stdin.end();
  assert.deepEqual(JSON.parse(line), { id: 1, ok: true, result: { ok: true, souls: [{ agentId: 'agent_1' }] } });
  assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 0);
});

test('auditExport saves the JSON to ~/Downloads, owner-only, without the client', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'bridge-home-'));
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = saved; });
  // Unpaired: the client never loads, yet the export still works.
  const h = harness(Object.assign(new Error('not paired'), { code: 'credential-invalid' }));
  await h.handle(JSON.stringify({ id: 1, method: 'auditExport', params: { contents: '[{"a":1}]' } }));
  await h.handle(JSON.stringify({ id: 2, method: 'auditExport', params: { contents: '[]' } }));
  assert.equal(h.loads(), 0);
  assert.deepEqual(h.out.map((r) => r.ok), [true, true]);
  const first = h.out[0].result.path;
  assert.equal(path.dirname(first), path.join(home, 'Downloads'));
  assert.match(path.basename(first), /^geniusbar-audit-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?\.json$/);
  assert.equal(readFileSync(first, 'utf8'), '[{"a":1}]');
  assert.equal(statSync(first).mode & 0o777, 0o600);
  // Two saves in the same millisecond never overwrite each other.
  assert.notEqual(h.out[1].result.path, first);
  assert.equal(readdirSync(path.join(home, 'Downloads')).length, 2);
});

test('auditExport refuses anything but a string of at most 50 MB', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'bridge-home-'));
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = saved; });
  const h = harness({});
  await h.handle(JSON.stringify({ id: 1, method: 'auditExport', params: { contents: { op: 'admin' } } }));
  await h.handle(JSON.stringify({ id: 2, method: 'auditExport', params: {} }));
  await h.handle(JSON.stringify({ id: 3, method: 'auditExport', params: { contents: 'x'.repeat(AUDIT_EXPORT_MAX + 1) } }));
  assert.deepEqual(h.out.map((r) => [r.id, r.error.code]), [[1, 'bad-request'], [2, 'bad-request'], [3, 'too-large']]);
  assert.throws(() => readdirSync(path.join(home, 'Downloads')), { code: 'ENOENT' });
});
