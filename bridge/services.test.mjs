import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refreshServices, removeServices, runsCopy } from './services.mjs';

const node = '/Applications/Genius Bar.app/Contents/MacOS/node';
const entry = '/Applications/Genius Bar.app/Contents/Resources/components/agent-comms/bin/agent-comms.mjs';
const plist = (n, e) => `<plist><dict><key>ProgramArguments</key><array>
  <string>${n}</string><string>${e}</string><string>broker</string><string>run</string>
</array></dict></plist>`;
const units = { broker: 'B', daemon: 'D' };

function fake(script) {
  const calls = [];
  const run = async (args) => {
    const key = args.join(' ');
    calls.push(key);
    if (!(key in script)) throw new Error(`unexpected: ${key}`);
    return script[key];
  };
  return { run, calls };
}

test('recognizes the copy a plist runs, escaped as launchd writes it', () => {
  assert.equal(runsCopy(plist(node, entry), node, entry), true);
  assert.equal(runsCopy(plist('/old/node', entry), node, entry), false);
  assert.equal(runsCopy(plist(node, '/old/agent-comms.mjs'), node, entry), false);
  assert.equal(runsCopy(plist('/a&amp;b/node', entry), '/a&b/node', entry), true);
});

test('refresh leaves current services alone and re-registers moved ones', async () => {
  const cli = fake({ 'broker install': { ok: true, installed: true } });
  const bot = fake({ 'daemon install --json': { label: 'app.geniusbar.agent-bot', changed: false, loaded: true } });
  const current = { B: plist(node, entry), D: '<plist/>' };
  assert.deepEqual(await refreshServices({ units, read: (f) => current[f], node, commsEntry: entry, cli: cli.run, bot: bot.run }),
    { broker: 'current', daemon: 'current' });
  assert.deepEqual(cli.calls, []);

  const moved = { B: plist('/Users/me/Downloads/GeniusBar.app/Contents/MacOS/node', entry), D: '<plist/>' };
  const bot2 = fake({ 'daemon install --json': { label: 'app.geniusbar.agent-bot', changed: true, loaded: true } });
  assert.deepEqual(await refreshServices({ units, read: (f) => moved[f], node, commsEntry: entry, cli: cli.run, bot: bot2.run }),
    { broker: 'reinstalled', daemon: 'reinstalled' });
  assert.deepEqual(cli.calls, ['broker install']);
});

test('refresh restarts unchanged units when the running version moved (#34)', async () => {
  const kicks = [];
  const kickstart = async (which) => { kicks.push(which); return true; };
  const stamp = {
    version: '0.1.0',
    read: async () => stamp.version,
    write: async (v) => { stamp.version = v; },
  };
  const cli = fake({});
  const bot = fake({ 'daemon install --json': { label: 'app.geniusbar.agent-bot', changed: false, loaded: true } });
  const current = { B: plist(node, entry), D: '<plist/>' };
  assert.deepEqual(await refreshServices({ units, read: (f) => current[f], node, commsEntry: entry,
    cli: cli.run, bot: bot.run, version: '0.1.1', stamp, kickstart }),
    { broker: 'restarted', daemon: 'restarted' });
  assert.deepEqual(kicks, ['broker', 'daemon']);
  assert.equal(stamp.version, '0.1.1');
});

test('a missing stamp means never reconciled: the first refresh restarts', async () => {
  const kicks = [];
  const stamp = { read: async () => null, write: async () => {} };
  const kickstart = async (which) => { kicks.push(which); return true; };
  const bot = fake({ 'daemon install --json': { label: 'app.geniusbar.agent-bot', changed: false, loaded: true } });
  const current = { B: plist(node, entry), D: '<plist/>' };
  assert.deepEqual(await refreshServices({ units, read: (f) => current[f], node, commsEntry: entry,
    cli: fake({}).run, bot: bot.run, version: '0.1.1', stamp, kickstart }),
    { broker: 'restarted', daemon: 'restarted' });
  assert.deepEqual(kicks, ['broker', 'daemon']);
});

test('the stamped version leaves current services alone', async () => {
  const stamp = { read: async () => '0.1.1', written: null, write: async (v) => { stamp.written = v; } };
  const kickstart = async () => { throw new Error('must not run'); };
  const bot = fake({ 'daemon install --json': { label: 'app.geniusbar.agent-bot', changed: false, loaded: true } });
  const current = { B: plist(node, entry), D: '<plist/>' };
  assert.deepEqual(await refreshServices({ units, read: (f) => current[f], node, commsEntry: entry,
    cli: fake({}).run, bot: bot.run, version: '0.1.1', stamp, kickstart }),
    { broker: 'current', daemon: 'current' });
  assert.equal(stamp.written, '0.1.1');
});

test('absent units stay absent and still move the stamp forward', async () => {
  const stamp = { read: async () => '0.1.0', written: null, write: async (v) => { stamp.written = v; } };
  const kickstart = async () => { throw new Error('must not run'); };
  assert.deepEqual(await refreshServices({ units, read: () => null, node, commsEntry: entry,
    cli: fake({}).run, bot: fake({}).run, version: '0.1.1', stamp, kickstart }),
    { broker: 'absent', daemon: 'absent' });
  assert.equal(stamp.written, '0.1.1');
});

test('a broker that will not kickstart is reinstalled instead', async () => {
  const cli = fake({ 'broker install': { ok: true, installed: true } });
  const bot = fake({ 'daemon install --json': { label: 'app.geniusbar.agent-bot', changed: false, loaded: true } });
  const stamp = { read: async () => '0.1.0', write: async () => {} };
  const kickstart = async (which) => which === 'daemon';
  const current = { B: plist(node, entry), D: '<plist/>' };
  assert.deepEqual(await refreshServices({ units, read: (f) => current[f], node, commsEntry: entry,
    cli: cli.run, bot: bot.run, version: '0.1.1', stamp, kickstart }),
    { broker: 'reinstalled', daemon: 'restarted' });
  assert.deepEqual(cli.calls, ['broker install']);
});

test('a daemon that will not restart after install fails the refresh', async () => {
  const bot = fake({ 'daemon install --json': { label: 'app.geniusbar.agent-bot', changed: false, loaded: true } });
  const stamp = { read: async () => '0.1.0', write: async () => { throw new Error('must not write'); } };
  const current = { B: plist(node, entry), D: '<plist/>' };
  // The broker kickstarts fine; the daemon's failure stops the stamp write.
  const kickstart = async (which) => which === 'broker';
  await assert.rejects(refreshServices({ units, read: (f) => current[f], node, commsEntry: entry,
    cli: fake({}).run, bot: bot.run, version: '0.1.1', stamp, kickstart }),
    { code: 'daemon-restart-failed' });
});

test('refresh never registers a service setup did not, and reports failures', async () => {
  const none = fake({});
  assert.deepEqual(await refreshServices({ units, read: () => null, node, commsEntry: entry, cli: none.run, bot: none.run }),
    { broker: 'absent', daemon: 'absent' });
  assert.deepEqual(none.calls, []);
  const cli = fake({ 'broker install': { ok: false, error: { code: 'launchagent-load-failed', message: 'no' } } });
  await assert.rejects(refreshServices({ units, read: (f) => (f === 'B' ? plist('/old', entry) : null), node, commsEntry: entry,
    cli: cli.run, bot: none.run }), { code: 'launchagent-load-failed' });
});

test('remove unloads and deletes both GeniusBar units, skipping absent ones', async () => {
  const cli = fake({ 'broker uninstall': { ok: true, installed: false, unloaded: true } });
  const bot = fake({ 'daemon disable --json': { unloaded: true } });
  const stamp = { cleared: 0, clear: async () => { stamp.cleared += 1; } };
  assert.deepEqual(await removeServices({ units, read: () => 'x', cli: cli.run, bot: bot.run, stamp }),
    { daemon: 'removed', broker: 'removed' });
  assert.equal(stamp.cleared, 1);
  const none = fake({});
  assert.deepEqual(await removeServices({ units, read: () => null, cli: none.run, bot: none.run }), { daemon: 'absent', broker: 'absent' });
  const stuck = fake({ 'daemon disable --json': { ok: false, error: { code: 'launchctl-failed', message: 'busy' } } });
  await assert.rejects(removeServices({ units, read: () => 'x', cli: none.run, bot: stuck.run }), { code: 'launchctl-failed' });
});
